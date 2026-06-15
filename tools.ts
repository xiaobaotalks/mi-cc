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
  /^\s*:(){ :\|:& };:/i,
] as const;

// ==================== 工具实现函数 ====================

export async function toolReadFile(args: Record<string, unknown>): Promise<string> {
  const filePath = args.path as string;
  try {
    if (!fs.existsSync(filePath)) {
      return `错误: 文件不存在 ${filePath}`;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_READ_FILE_SIZE) {
      return `错误: 文件过大 (${(stat.size / 1024).toFixed(0)}KB)，超过限制 (${MAX_READ_FILE_SIZE / 1024}KB)。请使用 runShell 配合 head/tail 读取部分内容。`;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return `文件内容 (${filePath}):\n${content}`;
  } catch (error) {
    return `读取失败: ${error}`;
  }
}

export async function toolWriteFile(args: Record<string, unknown>): Promise<string> {
  const filePath = args.path as string;
  const content = args.content as string;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return `成功写入文件: ${filePath}`;
  } catch (error) {
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

  const danger = isDangerousCommand(command);
  if (danger) {
    appendNote(`[安全] 已拦截危险命令: ${command}`);
    return `错误: 检测到潜在危险命令（匹配: ${danger}），已拒绝执行。如确需执行，请直接在终端运行。`;
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
          resolve(`命令执行错误: ${reason}${stderr ? '\n' + stderr : ''}`);
        } else {
          resolve(`执行结果:\n${(stdout || stderr || '无输出').toString()}`);
        }
      },
    );
  });
}

export async function toolGit(args: Record<string, unknown>): Promise<string> {
  const operation = args.operation as string;
  if (!operation || typeof operation !== 'string' || !operation.trim()) {
    return '错误: git 操作不能为空';
  }
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
