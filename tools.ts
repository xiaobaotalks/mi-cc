/**
 * 工具系统：内置工具定义、危险命令拦截、工具注册辅助
 * 通过 createBuiltinTools() 获取内置工具，外部用 toolsToOpenAIFormat() 转 LLM 格式
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import type OpenAI from 'openai';
import type { Tool } from './types';
import { appendNote } from './memory';

// ==================== 常量 ====================

export const SHELL_TIMEOUT_MS = 30_000;
/** readFile 工具允许读取的最大文件大小（1MB） */
export const MAX_READ_FILE_SIZE = 1024 * 1024;

/** 用户自定义允许列表的持久化文件 */
const USER_ALLOW_LIST_FILE = '.mi-cc-allow.json';

/** 命令授权回调类型：返回 'yes' | 'no' | 'always' */
export type AuthorizeResult = 'yes' | 'no' | 'always';
export type CommandAuthorizer = (command: string, reason: string) => Promise<AuthorizeResult>;

/** 运行时注入的命令授权器（由 cli.ts 设置，复用 REPL readline） */
let commandAuthorizer: CommandAuthorizer | null = null;

/** 设置命令授权器，供非白名单命令交互式授权 */
export function setCommandAuthorizer(fn: CommandAuthorizer | null): void {
  commandAuthorizer = fn;
}

/** 用户自定义允许列表（持久化到 .mi-cc-allow.json） */
let userAllowList: Set<string> = new Set();

/** 加载用户允许列表 */
export function loadUserAllowList(): void {
  try {
    if (fs.existsSync(USER_ALLOW_LIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_ALLOW_LIST_FILE, 'utf-8'));
      userAllowList = new Set(Array.isArray(data) ? data : []);
    }
  } catch {
    userAllowList = new Set();
  }
}

/** 保存用户允许列表 */
function saveUserAllowList(): void {
  try {
    fs.writeFileSync(USER_ALLOW_LIST_FILE, JSON.stringify([...userAllowList], null, 2), 'utf-8');
  } catch {
    // ignore
  }
}

/** 添加命令到用户允许列表 */
export function addUserAllowedCommand(cmd: string): void {
  const base = cmd.trim().split(/\s+/)[0].split('/').pop() || '';
  if (base) {
    userAllowList.add(base);
    saveUserAllowList();
  }
}

/** 移除用户允许列表中的命令 */
export function removeUserAllowedCommand(cmd: string): boolean {
  const base = cmd.trim().split(/\s+/)[0].split('/').pop() || '';
  if (userAllowList.has(base)) {
    userAllowList.delete(base);
    saveUserAllowList();
    return true;
  }
  return false;
}

/** 获取用户允许列表 */
export function getUserAllowList(): string[] {
  return [...userAllowList].sort();
}
export const DANGEROUS_PATTERNS = [
  /^\s*rm\s+-rf?\s+\/\s*(?:$|\.)/,
  /^\s*rm\s+-rf?\s+\/(?:bin|boot|dev|etc|home|lib|opt|proc|root|sbin|sys|tmp|usr|var)\b/i,
  /^\s*rm\s+-rf?\s+[.~]/,                          // rm -rf . / rm -rf ~
  /^\s*rm\s+-rf?\s+\*/,                             // rm -rf *
  /^\s*(curl|wget)[^|]*\|\s*(bash|sh)\b/i,
  /^\s*mkfs(\.\w+)?\s+/i,
  /^\s*dd\s+if=/i,
  /^\s*shutdown\b/i,
  /^\s*reboot\b/i,
  /^\s*:\(\)\s*\{\s*:\|:&\s*\};:/,                  // fork bomb
  // Windows 危险命令
  /^\s*format\s+[A-Za-z]:/i,                        // format C:
  /^\s*rd\s+\/s\s+\/q/i,                            // rd /s /q C:\
  /^\s*del\s+\/s\s+\/q\s+[A-Za-z]:/i,              // del /s /q C:\*
  /^\s*net\s+(user|localgroup)\b/i,                 // net user / net localgroup
] as const;

/** Shell 命令白名单（默认允许的常见开发命令） */
export const SHELL_WHITELIST = new Set([
  // 通用 Unix 命令
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'awk', 'sed', 'wc', 'sort', 'uniq', 'diff',
  'npm', 'npx', 'yarn', 'pnpm', 'node',
  'git', 'tsc', 'eslint', 'prettier', 'tsx', 'vite',
  'mkdir', 'touch', 'cp', 'mv', 'rm',
  'python', 'python3', 'pip', 'pip3',
  'docker', 'docker-compose',
  'curl', 'wget',
  'echo', 'pwd', 'which', 'whoami', 'date', 'env', 'export',
  'tar', 'zip', 'unzip', 'chmod', 'chown',
  'jq', 'yq',
  // Windows 兼容命令（不含 powershell/pwsh/cmd，这些可执行任意命令绕过白名单）
  'dir', 'type', 'copy', 'move', 'del', 'ren', 'md',
  'where', 'cls',
  'Get-ChildItem', 'Get-Content', 'Set-Location', 'Copy-Item', 'Move-Item', 'New-Item',
]);

/** 管道到 shell 的黑名单（禁止 curl|bash 等） */
const PIPE_TO_SHELL_PATTERN = /^\s*(curl|wget)[^|]*\|\s*(bash|sh|zsh|fish|ksh)\b/i;

/** 路径逃逸模式：禁止 ../ 路径穿越 */
const PATH_TRAVERSAL_PATTERN = /\.\.[/\\]/;

/** 检查命令是否被允许执行（支持管道和链接符，每个子命令都需通过白名单） */
export function isCommandAllowed(command: string): { allowed: boolean; reason?: string; needAuthorize?: string } {
  const trimmed = command.trim();

  // 1. 检查管道到 shell 的黑名单
  if (PIPE_TO_SHELL_PATTERN.test(trimmed)) {
    return { allowed: false, reason: '禁止管道到 shell 解释器执行' };
  }

  // 2. 检查路径逃逸（../ 穿越项目目录）
  if (PATH_TRAVERSAL_PATTERN.test(trimmed)) {
    return { allowed: false, reason: '禁止路径逃逸 (../)' };
  }

  // 3. 检查黑名单（对完整命令和每个子命令都检查）
  const danger = isDangerousCommand(trimmed);
  if (danger) {
    return { allowed: false, reason: `匹配危险命令模式: ${danger}` };
  }

  // 4. 按链接符拆分为子命令，每个子命令都需通过白名单和危险检查
  // 支持 ; && || | 等常见 shell 链接符
  const subCommands = trimmed.split(/\s*(?:;|&&|\|\||\|)\s*/).filter(s => s.length > 0);
  for (const sub of subCommands) {
    // 子命令级别的危险检查
    const subDanger = isDangerousCommand(sub);
    if (subDanger) {
      return { allowed: false, reason: `匹配危险命令模式: ${subDanger}` };
    }
    const firstWord = sub.split(/\s+/)[0];
    const baseName = firstWord.split('/').pop() || '';
    // 检查内置白名单或用户自定义允许列表
    if (!SHELL_WHITELIST.has(baseName) && !userAllowList.has(baseName)) {
      // 非白名单命令，标记需要授权（不直接拒绝，由 toolRunShell 决定是否交互式授权）
      return { allowed: false, reason: `命令 "${baseName}" 不在白名单中`, needAuthorize: baseName };
    }
  }

  return { allowed: true };
}

/** 规范化文件路径并检查是否在项目目录内 */
export function normalizeFilePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    throw new Error(`路径超出项目目录: ${inputPath}`);
  }
  return resolved;
}

const AUDIT_LOG_FILE = 'audit.log';
/** 审计日志最大大小（1MB），超过后自动轮转 */
const AUDIT_LOG_MAX_SIZE = 1024 * 1024;

function writeAuditLog(toolName: string, detail: string, success: boolean): void {
  const timestamp = new Date().toISOString();
  const status = success ? '✓' : '✗';
  const line = `[${timestamp}] [${toolName}] ${status} ${detail}\n`;
  try {
    // 日志轮转：超过大小限制时重命名为 .old 并重新创建
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const stat = fs.statSync(AUDIT_LOG_FILE);
      if (stat.size > AUDIT_LOG_MAX_SIZE) {
        fs.renameSync(AUDIT_LOG_FILE, `${AUDIT_LOG_FILE}.old`);
      }
    }
    fs.appendFileSync(AUDIT_LOG_FILE, line, 'utf-8');
  } catch {
    // ignore
  }
}

// ==================== 工具实现函数 ====================

export async function toolReadFile(args: Record<string, unknown>): Promise<string> {
  let filePath = args.path as string;
  try {
    filePath = normalizeFilePath(filePath);
  } catch (e) {
    writeAuditLog('readFile', String(filePath), false);
    return `错误: ${(e as Error).message}`;
  }
  try {
    if (!fs.existsSync(filePath)) {
      return `错误: 文件不存在 ${filePath}`;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_READ_FILE_SIZE) {
      return `错误: 文件过大 (${(stat.size / 1024).toFixed(0)}KB)，超过限制 (${MAX_READ_FILE_SIZE / 1024}KB)。请使用 runShell 配合 head/tail 读取部分内容。`;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    writeAuditLog('readFile', filePath, true);
    return `文件内容 (${filePath}):\n${content}`;
  } catch (error) {
    writeAuditLog('readFile', filePath, false);
    return `读取失败: ${error}`;
  }
}

/** writeFile 最大内容限制（1MB） */
const MAX_WRITE_FILE_SIZE = 1024 * 1024;

export async function toolWriteFile(args: Record<string, unknown>): Promise<string> {
  let filePath = args.path as string;
  const content = args.content as string;

  // 内容大小限制
  if (content && content.length > MAX_WRITE_FILE_SIZE) {
    writeAuditLog('writeFile', String(filePath), false);
    return `错误: 文件内容超过 ${MAX_WRITE_FILE_SIZE / 1024 / 1024}MB 限制（当前 ${Math.round(content.length / 1024)}KB）`;
  }

  try {
    filePath = normalizeFilePath(filePath);
  } catch (e) {
    writeAuditLog('writeFile', String(filePath), false);
    return `错误: ${(e as Error).message}`;
  }
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    writeAuditLog('writeFile', filePath, true);
    return `成功写入文件: ${filePath}`;
  } catch (error) {
    writeAuditLog('writeFile', filePath, false);
    return `写入失败: ${error}`;
  }
}

export function isDangerousCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.source;
    }
  }
  return null;
}

export async function toolRunShell(args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  if (!command || typeof command !== 'string') {
    return '错误: 命令不能为空';
  }

  const check = isCommandAllowed(command);
  if (!check.allowed) {
    // 非白名单命令（但非危险命令）：尝试交互式授权
    if (check.needAuthorize && commandAuthorizer) {
      const decision = await commandAuthorizer(command, check.reason || '');
      if (decision === 'no') {
        appendNote(`[安全] 用户拒绝命令: ${command}`);
        writeAuditLog('runShell', command, false);
        return `错误: 用户拒绝执行命令 "${command}"`;
      }
      if (decision === 'always') {
        addUserAllowedCommand(check.needAuthorize);
        appendNote(`[安全] 用户永久允许命令: ${check.needAuthorize}`);
      }
      // 'yes' 或 'always' 都继续执行
    } else {
      // 无授权器或危险命令：直接拒绝
      appendNote(`[安全] 已拦截命令: ${command} (${check.reason})`);
      writeAuditLog('runShell', command, false);
      return `错误: ${check.reason}。如需授权非白名单命令，可在 REPL 中输入 /allow <命令名>`;
    }
  }

  const timeoutMs = typeof args.timeout === 'number' ? args.timeout : SHELL_TIMEOUT_MS;

  return new Promise((resolve) => {
    exec(
      command,
      {
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        windowsHide: true,
      },
      (error: Error & { killed?: boolean; signal?: string } | null, stdout: string, stderr: string) => {
        if (error) {
          const reason = error.killed ? `超时被终止 (${error.signal || 'SIGTERM'})` : error.message;
          writeAuditLog('runShell', command, false);
          resolve(`命令执行错误: ${reason}\n${stderr}`);
        } else {
          writeAuditLog('runShell', command, true);
          resolve(`执行结果:\n${(stdout || stderr || '无输出').toString()}`);
        }
      },
    );
  });
}

/** git 允许的子命令白名单 */
const GIT_SAFE_OPERATIONS = new Set([
  'status', 'log', 'diff', 'branch', 'tag', 'remote',
  'add', 'stash', 'fetch', 'pull', 'clone', 'init',
  'commit', 'checkout', 'switch', 'merge', 'rebase', 'reset',
  'show', 'blame', 'shortlog', 'describe', 'reflog',
]);

export async function toolGit(args: Record<string, unknown>): Promise<string> {
  const operation = args.operation as string;
  const params = (args.params as string[]) || [];

  // 校验 git 子命令
  if (!GIT_SAFE_OPERATIONS.has(operation)) {
    // push --force 等危险操作需通过 runShell 的安全审查
    return toolRunShell({ command: `git ${operation} ${params.join(' ')}` });
  }

  // 检查参数中是否包含危险标志
  const paramStr = params.join(' ');
  if (/\b--force\b/.test(paramStr) && (operation === 'push' || operation === 'reset')) {
    return '错误: 禁止 git push --force 和 git reset --force，请使用安全替代命令';
  }

  return toolRunShell({ command: `git ${operation} ${params.join(' ')}` });
}

// ==================== 联网工具 ====================

/** webFetch 抓取的最大内容长度（字符） */
const WEB_FETCH_MAX_LENGTH = 8000;
/** webFetch 超时时间 */
const WEB_FETCH_TIMEOUT_MS = 15_000;

/** 简易 HTML 标签清理：去除标签、脚本、样式，保留纯文本 */
function stripHtml(html: string): string {
  return html
    // 移除 script/style/noscript 块
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    // 移除 HTML 注释
    .replace(/<!--[\s\S]*?-->/g, '')
    // 块级标签转换行
    .replace(/<\/(p|div|br|h[1-6]|li|tr|table|hr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // 移除剩余标签
    .replace(/<[^>]+>/g, '')
    // HTML 实体解码
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // 压缩空白
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** webFetch 工具：抓取 URL 内容并返回纯文本 */
const WEB_FETCH_MAX_REDIRECTS = 5;

/** 检查 URL 是否为内网/私有地址（SSRF 防护） */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    // 拦截内网 IP 和云元数据
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
    if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;  // 172.16-31.x.x
    if (host.startsWith('169.254.')) return true;  // 云元数据
    if (host.endsWith('.internal') || host.endsWith('.local')) return true;
    return false;
  } catch {
    return true;
  }
}

export async function toolWebFetch(args: Record<string, unknown>, _redirectCount = 0): Promise<string> {
  const url = args.url as string;
  if (!url || typeof url !== 'string') {
    return '错误: url 参数不能为空';
  }

  // 仅允许 http/https
  if (!/^https?:\/\//i.test(url)) {
    return '错误: 仅支持 http/https 协议的 URL';
  }

  // SSRF 防护：禁止访问内网地址
  if (isPrivateUrl(url)) {
    return '错误: 禁止访问内网/私有地址（SSRF 防护）';
  }

  // 重定向次数限制
  if (_redirectCount >= WEB_FETCH_MAX_REDIRECTS) {
    return `错误: 重定向次数超过 ${WEB_FETCH_MAX_REDIRECTS} 次限制`;
  }

  const maxLen = typeof args.maxLength === 'number' ? args.maxLength : WEB_FETCH_MAX_LENGTH;

  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, {
      timeout: WEB_FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': 'mi-cc/2.3 (CLI Agent)',
        'Accept': 'text/html,application/json,text/plain,*/*',
      },
    }, (res: any) => {
      // 处理重定向（带次数限制）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        if (redirectUrl !== url) {
          toolWebFetch({ url: redirectUrl, maxLength: maxLen }, _redirectCount + 1).then(resolve);
          return;
        }
      }
      if (res.statusCode !== 200) {
        writeAuditLog('webFetch', url, false);
        resolve(`错误: HTTP ${res.statusCode} ${res.statusMessage || ''}`);
        return;
      }

      const contentType = res.headers['content-type'] || '';
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString('utf-8'); });
      res.on('end', () => {
        writeAuditLog('webFetch', url, true);
        let result: string;
        if (contentType.includes('application/json')) {
          // JSON 直接返回（格式化）
          try {
            result = JSON.stringify(JSON.parse(data), null, 2);
          } catch {
            result = data;
          }
        } else if (contentType.includes('text/html')) {
          result = stripHtml(data);
        } else {
          result = data;
        }

        if (result.length > maxLen) {
          result = result.substring(0, maxLen) + `\n\n... (内容过长，已截断，共 ${result.length} 字符)`;
        }
        resolve(`URL: ${url}\nContent-Type: ${contentType}\n\n${result}`);
      });
    });

    req.on('error', (err: Error) => {
      writeAuditLog('webFetch', url, false);
      resolve(`错误: 抓取失败 - ${err.message}`);
    });
    req.on('timeout', () => {
      req.destroy();
      writeAuditLog('webFetch', url, false);
      resolve(`错误: 请求超时 (${WEB_FETCH_TIMEOUT_MS}ms)`);
    });
  });
}

// ==================== 注册与格式化 ====================

/** 创建内置工具列表 */
export function createBuiltinTools(): Tool[] {
  return [
    {
      name: 'readFile',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
      execute: toolReadFile,
      source: 'builtin' as const,
    },
    {
      name: 'writeFile',
      description: '写入文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
      execute: toolWriteFile,
      source: 'builtin' as const,
    },
    {
      name: 'runShell',
      description: '执行 Shell 命令（带超时与危险命令拦截）',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell 命令' },
          timeout: { type: 'number', description: '超时毫秒数（默认 30000）' },
        },
        required: ['command'],
      },
      execute: toolRunShell,
      source: 'builtin' as const,
    },
    {
      name: 'git',
      description: 'Git 操作',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', description: 'Git 操作 (如 commit, push, pull)' },
          params: { type: 'array', items: { type: 'string' }, description: '参数列表' },
        },
        required: ['operation'],
      },
      execute: toolGit,
      source: 'builtin' as const,
    },
    {
      name: 'webFetch',
      description: '抓取 URL 内容并返回纯文本（支持 HTML 清理、JSON 格式化、自动跟随重定向）',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 URL（http/https）' },
          maxLength: { type: 'number', description: '返回内容最大字符数（默认 8000）' },
        },
        required: ['url'],
      },
      execute: toolWebFetch,
      source: 'builtin' as const,
    },
  ];
}

/** 将内部工具列表转为 OpenAI Function Calling 格式 */
export function toolsToOpenAIFormat(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** 执行单个工具调用 */
export async function executeToolCall(tools: Tool[], name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return `错误: 未知工具 ${name}`;
  }
  return tool.execute(args);
}

/** 从工具调用参数中提取受影响的文件路径 */
export function extractFileFromArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'readFile' || toolName === 'writeFile') {
    return (args.path as string) || '';
  }
  if (toolName === 'git' && Array.isArray(args.params) && args.params.length > 0) {
    const first = args.params[0];
    if (typeof first === 'string' && !first.startsWith('-')) return first;
  }
  return '';
}
