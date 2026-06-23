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
export const DANGEROUS_PATTERNS = [
  /^\s*rm\s+-rf?\s+\/\s*(?:$|\.)/,
  /^\s*rm\s+-rf?\s+\/(?:bin|boot|dev|etc|home|lib|opt|proc|root|sbin|sys|tmp|usr|var)\b/i,
  /^\s*(curl|wget)[^|]*\|\s*(bash|sh)\b/i,
  /^\s*mkfs(\.\w+)?\s+/i,
  /^\s*dd\s+if=/i,
  /^\s*shutdown\b/i,
  /^\s*reboot\b/i,
  /^\s*:\(\)\s*\{\s*:\|:&\s*\};:/,
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
  // Windows 兼容命令
  'dir', 'type', 'copy', 'move', 'del', 'ren', 'md',
  'powershell', 'pwsh', 'cmd', 'where', 'cls',
  'Get-ChildItem', 'Get-Content', 'Set-Location', 'Copy-Item', 'Move-Item', 'New-Item',
]);

/** 管道到 shell 的黑名单（禁止 curl|bash 等） */
const PIPE_TO_SHELL_PATTERN = /^\s*(curl|wget)[^|]*\|\s*(bash|sh|zsh|fish|ksh)\b/i;

/** 检查命令是否被允许执行（支持管道和链接符，每个子命令都需通过白名单） */
export function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const trimmed = command.trim();

  // 1. 检查管道到 shell 的黑名单
  if (PIPE_TO_SHELL_PATTERN.test(trimmed)) {
    return { allowed: false, reason: '禁止管道到 shell 解释器执行' };
  }

  // 2. 检查黑名单（对完整命令和每个子命令都检查）
  const danger = isDangerousCommand(trimmed);
  if (danger) {
    return { allowed: false, reason: `匹配危险命令模式: ${danger}` };
  }

  // 3. 按链接符拆分为子命令，每个子命令都需通过白名单和危险检查
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
    if (!SHELL_WHITELIST.has(baseName)) {
      return { allowed: false, reason: `命令 "${baseName}" 不在白名单中，如需执行请在终端直接运行` };
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

export async function toolWriteFile(args: Record<string, unknown>): Promise<string> {
  let filePath = args.path as string;
  const content = args.content as string;
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
    appendNote(`[安全] 已拦截命令: ${command} (${check.reason})`);
    writeAuditLog('runShell', command, false);
    return `错误: ${check.reason}`;
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

export async function toolGit(args: Record<string, unknown>): Promise<string> {
  const operation = args.operation as string;
  const params = (args.params as string[]) || [];
  return toolRunShell({ command: `git ${operation} ${params.join(' ')}` });
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
