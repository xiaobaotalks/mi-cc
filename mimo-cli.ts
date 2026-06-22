#!/usr/bin/env node
/**
 * MiMo Code CLI - 最简化版
 * 技术栈: Node.js + TypeScript + Commander + fs + JSON
 * 功能: 终端对话、工具调用、四层记忆、上下文压缩、简易蒸馏
 */

import * as readline from 'readline';
import * as fs from 'fs';
import { Command } from 'commander';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import {
  tieredCompact,
  estimateTotalTokens,
  saveStateFromMessages,
  resolveContextWindow,
  loadCompressState,
} from './compress';
import { matchSkill, formatSkillForPrompt } from './skills';
import type { Message, Tool, HistoryRecord, Config, Checkpoint } from './types';
import {
  createBuiltinTools,
  toolsToOpenAIFormat,
  executeToolCall,
  extractFileFromArgs,
  toolRunShell,
} from './tools';
import {
  handleSlashCommand,
  initMcpTools,
  SLASH_COMMANDS,
  type SlashContext,
} from './commands';
import { ProviderRouter } from './src/router';
// 启动时自动加载上次激活的 Provider
import { loadProviders, type ProviderEntry } from './commands';
import {
  readCheckpoint,
  writeCheckpoint,
  readMemory,
  readNotes,
  appendNote,
  initHistory,
  saveHistory,
  generateSessionId,
  SKILL_LIB_FILE,
} from './memory';
import { mcpMode } from './mcp-mode';
import { appState } from './src/state';
import { loadConfig } from './src/config';

// ==================== 常量 ====================

/** Agent 循环最大工具调用轮数，防止无限循环 */
const MAX_TOOL_ITERATIONS = 20;

/** LLM 调用超时时间（毫秒） */
const LLM_TIMEOUT_MS = 30_000;
/** LLM 调用最大重试次数（仅对 server/unknown 错误） */
const LLM_MAX_RETRIES = 3;

// ==================== 全局变量 ====================

let slashCtx: SlashContext;
let router: ProviderRouter | null = null;

// 启动像素标识
// 注意：CJK 字符在终端占 2 列宽，源码只算 1 字符；排版时按 CJK 字符数 -1 计算空格
// 所有行（外框/内框/内容）终端列宽统一为 56
const BANNER = `
╔══════════════════════════════════════════════════════╗
║  ███╗   ███╗     ██████╗ ██████╗ ██████╗ ███████╗    ║
║  ████╗ ████║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝    ║
║  ██╔████╔██║    ██║     ██║   ██║██║  ██║█████╗      ║
║  ██║╚██╔╝██║    ██║     ██║   ██║██║  ██║██╔══╝      ║
║  ██║ ╚═╝ ██║    ╚██████╗╚██████╔╝██████╔╝███████╗    ║
║  ╚═╝     ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝    ║
╠══════════════════════════════════════════════════════╣
║  ▓▒░  ╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮  ░▒▓  ║
║  ▓▒░  ┃ ✦  【 为 发 烧 而 生 】  ✦  mi-cc  ┃  ░▒▓  ║
║  ▓▒░  ┃    智能编程助手 · LLM Agent Shell    ┃  ░▒▓  ║
║  ▓▒░  ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯  ░▒▓  ║
╚══════════════════════════════════════════════════════╝
`;

// ==================== 初始化 ====================

function initOpenAI(cfg: { apiKey: string; baseUrl: string }): OpenAI {
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  });
}

// ==================== 上下文压缩包装 ====================

async function compactContext(): Promise<void> {
  const result = await tieredCompact(
    appState.get('openai'),
    appState.get('config').model,
    appState.get('conversationHistory'),
    appState.get('config').maxTokens,
    (msg) => console.log(msg),
  );

  if (!result.changed) {
    if (result.tier === 'none') {
      const total = estimateTotalTokens(appState.get('conversationHistory'));
      console.log(`[压缩] 当前 token ${total}，无需压缩`);
    }
    return;
  }

  appState.set('conversationHistory', result.messages);
  saveStateFromMessages(appState.get('conversationHistory'));
  console.log(`[压缩] 完成 (${result.tier})，当前 token ${estimateTotalTokens(appState.get('conversationHistory'))}`);
  appendNote(`上下文压缩完成（${result.tier}），剩余 token: ${estimateTotalTokens(appState.get('conversationHistory'))}`);
}

// ==================== System Prompt ====================

let systemPromptCache: { mtime: number; prompt: string } | null = null;

function getMemoryMTime(): number {
  let mtime = 0;
  for (const file of ['MEMORY.md', 'notes.md', 'skill-lib.md', 'checkpoint.md']) {
    try {
      if (fs.existsSync(file)) {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > mtime) mtime = stat.mtimeMs;
      }
    } catch {
      // ignore
    }
  }
  return mtime;
}

function buildSystemPrompt(currentUserInput?: string): string {
  const mtime = getMemoryMTime();
  if (systemPromptCache && systemPromptCache.mtime === mtime && !currentUserInput) {
    return systemPromptCache.prompt;
  }

  const memory = readMemory();
  const notes = readNotes();
  const checkpoint = readCheckpoint();
  const skillLib = fs.existsSync(SKILL_LIB_FILE) ? fs.readFileSync(SKILL_LIB_FILE, 'utf-8') : '';

  let systemPrompt = `你是一个智能编程助手 mi-cc。

## 当前会话
- Session ID: ${appState.get('currentSessionId')}
- 时间: ${new Date().toISOString()}

## 可用工具
${appState.get('tools').map(t => `- ${t.name}: ${t.description}${t.source === 'mcp' ? ' (MCP)' : ''}`).join('\n')}

## 工作原则
1. 使用工具完成任务
2. 保持简洁高效
3. 记录重要决策
4. 优先复用技能库中已有的工作流
`;

  if (memory) {
    systemPrompt += `\n## 项目记忆\n${memory}\n`;
  }

  if (notes) {
    systemPrompt += `\n## 笔记\n${notes}\n`;
  }

  if (checkpoint) {
    systemPrompt += `\n## 上次会话状态\n- 任务: ${checkpoint.task}\n- 当前文件: ${checkpoint.currentFile}\n- 最后操作: ${checkpoint.lastAction}\n`;
  }

  if (skillLib) {
    systemPrompt += `\n## 技能库（完整）\n${skillLib}\n`;
  }

  if (currentUserInput) {
    const matched = matchSkill(currentUserInput);
    const text = formatSkillForPrompt(matched);
    if (text) {
      systemPrompt += `\n## 当前输入最相关的技能（请优先复用）\n${text}\n`;
      return systemPrompt;
    }
  }

  systemPromptCache = { mtime, prompt: systemPrompt };
  return systemPrompt;
}

// ==================== LLM 调用 ====================

/** 分类 LLM 错误类型 */
function classifyLLMError(error: unknown): 'auth' | 'rate_limit' | 'server' | 'context_length' | 'unknown' {
  const msg = (error as Error).message || String(error);
  if (/invalid.*api.*key|authentication|unauthorized|401/i.test(msg)) return 'auth';
  if (/rate.?limit|429|too.?many.?requests/i.test(msg)) return 'rate_limit';
  if (/context.?length|maximum.?context|too.?many.?tokens|prompt.*too.*long/i.test(msg)) return 'context_length';
  if (/500|502|503|504|econnrefused|econnreset|timeout|ETIMEDOUT/i.test(msg)) return 'server';
  return 'unknown';
}

/** 带超时的 LLM 调用 */
async function callLLMWithTimeout(messages: Message[]): Promise<Message> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await appState.get('openai').chat.completions.create({
      model: appState.get('config').model,
      messages: messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: toolsToOpenAIFormat(appState.get('tools')),
      tool_choice: 'auto',
      max_tokens: appState.get('config').maxTokens,
    }, { signal: controller.signal as any });
    return response.choices[0].message as unknown as Message;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callLLM(messages: Message[]): Promise<Message> {
  // --- 首次尝试 ---
  try {
    // 如果配置了 Router，使用 Router.chat()
    if (router) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      try {
        const response = await router.chat({
          messages,
          model: appState.get('config').model,
          maxTokens: appState.get('config').maxTokens,
          tools: toolsToOpenAIFormat(appState.get('tools')),
          toolChoice: 'auto',
          signal: controller.signal,
        });
        return response.message;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    // 没有 Router 时使用原来的逻辑
    return await callLLMWithTimeout(messages);
  } catch (error) {
    const category = classifyLLMError(error);

    // 认证错误：不重试，直接抛出
    if (category === 'auth') {
      throw new Error(`[LLM] 认证失败，请检查 API Key 是否正确。原始错误: ${error}`);
    }

    // 限速错误：不重试，提示用户
    if (category === 'rate_limit') {
      throw new Error(`[LLM] 请求频率超限（429），请稍后再试。原始错误: ${error}`);
    }

    // 上下文超限：保持现有压缩+降级逻辑
    if (category === 'context_length') {
      console.log(`[LLM] 触发上下文超限，自动压缩并降级重试...`);
      const reducedMax = Math.floor(appState.get('config').maxTokens * 0.9);
      appState.get('config').maxTokens = reducedMax;
      appendNote(`[LLM] 上下文超限，已将 maxTokens 降至 ${reducedMax}`);
      // 强制一次压缩
      const result = await tieredCompact(
        appState.get('openai'),
        appState.get('config').model,
        appState.get('conversationHistory'),
        reducedMax,
        (msg) => console.log(msg),
      );
      if (result.changed) {
        appState.set('conversationHistory', result.messages);
        saveStateFromMessages(appState.get('conversationHistory'));
      }
      // 用压缩后的 history 重试一次（不使用 Router，保持原有逻辑）
      const retryMessages: Message[] = [
        { role: 'system', content: buildSystemPrompt() },
        ...appState.get('conversationHistory'),
      ];
      return await callLLMWithTimeout(retryMessages);
    }

    // server / unknown 错误：指数退避重试（Router 已经处理过故障转移）
    for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
      const delay = 500 * Math.pow(2, attempt);
      console.log(`[LLM] ${category === 'server' ? '服务端' : '未知'}错误，第 ${attempt + 1}/${LLM_MAX_RETRIES} 次重试，等待 ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        // 重试时仍然使用 Router（如果可用）
        if (router) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
          try {
            const response = await router.chat({
              messages,
              model: appState.get('config').model,
              maxTokens: appState.get('config').maxTokens,
              tools: toolsToOpenAIFormat(appState.get('tools')),
              toolChoice: 'auto',
              signal: controller.signal,
            });
            return response.message;
          } finally {
            clearTimeout(timeoutId);
          }
        }
        return await callLLMWithTimeout(messages);
      } catch (retryError) {
        const retryCategory = classifyLLMError(retryError);
        // 重试过程中遇到不可恢复的错误，立即抛出
        if (retryCategory === 'auth' || retryCategory === 'rate_limit') {
          throw new Error(`[LLM] 重试过程中遇到${retryCategory === 'auth' ? '认证' : '限速'}错误，终止重试。原始错误: ${retryError}`);
        }
        // context_length 在重试中也可以处理
        if (retryCategory === 'context_length') {
          console.log(`[LLM] 重试时触发上下文超限，自动压缩并降级重试...`);
          const reducedMax = Math.floor(appState.get('config').maxTokens * 0.9);
          appState.get('config').maxTokens = reducedMax;
          appendNote(`[LLM] 上下文超限，已将 maxTokens 降至 ${reducedMax}`);
          const result = await tieredCompact(
            appState.get('openai'),
            appState.get('config').model,
            appState.get('conversationHistory'),
            reducedMax,
            (msg) => console.log(msg),
          );
          if (result.changed) {
            appState.set('conversationHistory', result.messages);
            saveStateFromMessages(appState.get('conversationHistory'));
          }
          const retryMessages: Message[] = [
            { role: 'system', content: buildSystemPrompt() },
            ...appState.get('conversationHistory'),
          ];
          return await callLLMWithTimeout(retryMessages);
        }
        // 最后一次重试仍失败，抛出错误
        if (attempt === LLM_MAX_RETRIES - 1) {
          throw new Error(`[LLM] 调用失败（已重试 ${LLM_MAX_RETRIES} 次）。原始错误: ${retryError}`);
        }
      }
    }
  }

  // 理论上不会到达此处，但 TypeScript 需要返回值
  throw new Error('[LLM] 调用失败: 未知错误');
}

// ==================== Agent 循环 ====================

function formatTimeShort(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** 缩进多行输出，保持工具调用框视觉对齐 */
function indentBlock(text: string, prefix: string): string {
  return text.split('\n').map(line => line.length > 0 ? prefix + line : line).join('\n');
}

/** 截断过长结果用于终端预览，保留完整结果到 history */
function previewResult(result: string, maxLen = 400): string {
  if (result.length <= maxLen) return result;
  const head = result.substring(0, maxLen);
  const omitted = result.length - maxLen;
  return `${head}\n... (省略 ${omitted} 字符，完整内容已记录到 history)`;
}

async function handleToolCalls(message: OpenAI.Chat.Completions.ChatCompletionMessage): Promise<string[]> {
  if (!message.tool_calls || message.tool_calls.length === 0) {
    return [];
  }

  const results: string[] = [];
  let lastFile = readCheckpoint()?.currentFile || '';
  const isMulti = message.tool_calls.length > 1;

  for (let idx = 0; idx < message.tool_calls.length; idx++) {
    const toolCall = message.tool_calls[idx];
    const toolName = toolCall.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      results.push(`错误: 工具 ${toolName} 的参数 JSON 解析失败: ${toolCall.function.arguments}`);
      continue;
    }

    // 边框字符：多步调用用 ┌/└ 分隔每步；单步用单行格式
    const top = isMulti ? '┌─' : '──';
    const mid = isMulti ? '├─' : '  ';
    const bot = isMulti ? '└─' : '──';
    const cont = isMulti ? '│' : ' ';

    console.log(`${top} [${formatTimeShort()}] 🔧 ${toolName}(${JSON.stringify(args)})`);

    const t0 = Date.now();
    const result = await executeToolCall(appState.get('tools'), toolName, args);
    const elapsed = Date.now() - t0;
    results.push(result);

    const isError = result.startsWith('错误:') || result.startsWith('命令执行错误:') || result.startsWith('读取失败') || result.startsWith('写入失败');
    const status = isError ? '✗ 失败' : '✓ 成功';
    const lines = result.split('\n').length;
    console.log(`${mid} [${formatTimeShort()}] ${status} (${elapsed}ms, ${result.length} 字符, ${lines} 行)`);
    console.log(`${cont} ${indentBlock(previewResult(result), isMulti ? '│ ' : '  ').trimStart()}`);

    if (isMulti) console.log(bot);

    const file = extractFileFromArgs(toolName, args);
    if (file) lastFile = file;

    writeCheckpoint({
      sessionId: appState.get('currentSessionId'),
      task: appState.get('conversationHistory').find(m => m.role === 'user')?.content?.substring(0, 100) || '',
      currentFile: lastFile,
      lastAction: toolName,
      result: result.substring(0, 200),
      stage: '执行中',
      time: new Date().toISOString(),
    });
  }

  return results;
}

async function agentLoop(userInput: string): Promise<void> {
  appState.get('conversationHistory').push({ role: 'user', content: userInput });
  appState.set('historyData', saveHistory(appState.get('historyData'), appState.get('currentSessionId'), 'user', userInput));

  await compactContext();

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(userInput) },
    ...appState.get('conversationHistory'),
  ];

  let response = await callLLM(messages);

  let iterations = 0;
  while (true) {
    appState.get('conversationHistory').push(response);
    appState.set('historyData', saveHistory(appState.get('historyData'), appState.get('currentSessionId'), 'assistant', response.content || JSON.stringify(response)));

    if (response.content) {
      console.log(`\n[${formatTimeShort()}] 💬 [助手]\n${response.content}\n`);
    }

    const toolCalls = (response as OpenAI.Chat.Completions.ChatCompletionMessage).tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      break;
    }

    iterations++;
    if (iterations > MAX_TOOL_ITERATIONS) {
      console.log(`[警告] 已达到最大工具调用轮数 (${MAX_TOOL_ITERATIONS})，强制停止`);
      break;
    }

    const results = await handleToolCalls(response as OpenAI.Chat.Completions.ChatCompletionMessage);

    for (let i = 0; i < toolCalls.length; i++) {
      appState.get('conversationHistory').push({
        role: 'tool',
        content: results[i],
        tool_call_id: toolCalls[i].id,
      });
    }

    const nextMessages: Message[] = [
      { role: 'system', content: buildSystemPrompt() },
      ...appState.get('conversationHistory'),
    ];
    response = await callLLM(nextMessages);
  }

  writeCheckpoint({
    sessionId: appState.get('currentSessionId'),
    task: userInput.substring(0, 100),
    currentFile: '',
    lastAction: '对话',
    result: response.content?.substring(0, 200) || '',
    stage: '完成',
    time: new Date().toISOString(),
  });
}

// ==================== 主程序 ====================

async function main() {
  const program = new Command();
  program
    .name('mi-cc')
    .description('mi-cc - 智能编程助手 (MCP Server / CLI)')
    .version('1.1.0')
    .option('-s, --session <id>', '指定会话 ID')
    .option('--mcp', '以 MCP Server 模式启动（StdioServerTransport）')
    .parse(process.argv);

  const options = program.opts();

  // MCP Server 模式：提前退出 CLI 流程
  if (options.mcp) {
    await mcpMode();
    return;
  }

  console.log(BANNER);
  console.log('输入 /help 查看可用命令\n');

  const { config, warnings } = loadConfig();
  for (const w of warnings) console.log(`[警告] ${w}`);
  let openai = initOpenAI(config);
  let historyData = initHistory();
  let tools = createBuiltinTools();
  initMcpTools(tools, (cmd, timeout) =>
    toolRunShell({ command: cmd, timeout }),
  );

  // 启动时自动加载上次激活的 Provider（覆盖 .env 中的配置）
  try {
    const providers = loadProviders();
    const active = providers.find(p => p.active);
    if (active) {
      config.apiKey = active.apiKey;
      config.baseUrl = active.baseUrl;
      config.model = active.model;
      openai = initOpenAI(config);
      console.log(`[Provider] 已加载: ${active.name} (${active.model})`);
    }
  } catch {
    // ignore
  }

  // 恢复或创建会话
  const checkpoint = readCheckpoint();
  let currentSessionId: string;
  if (options.session) {
    currentSessionId = options.session;
  } else if (checkpoint && checkpoint.sessionId) {
    currentSessionId = checkpoint.sessionId;
    console.log(`[恢复会话] ${currentSessionId}`);
    console.log(`[上次任务] ${checkpoint.task}`);
  } else {
    currentSessionId = generateSessionId();
    console.log(`[新会话] ${currentSessionId}`);
  }

  // 初始化 appState
  appState.init({
    openai,
    config,
    currentSessionId,
    conversationHistory: [],
    tools,
    historyData,
  });

  // 如果配置了备用 Provider，初始化 Router
  const backupProviders = ProviderRouter.loadFromEnv();
  if (backupProviders.length > 0) {
    router = new ProviderRouter(config, backupProviders);
    console.log(`[Provider] 已加载 ${backupProviders.length + 1} 个 Provider（主 + ${backupProviders.length} 个备用）`);
  }

  // 构建斜杠命令上下文（直接引用 appState）
  slashCtx = {
    openai: appState.get('openai'),
    config: appState.get('config'),
    tools: appState.get('tools'),
  };

  // 恢复压缩摘要层
  const compressState = loadCompressState();
  if (compressState.summaries.length > 0) {
    const summaryMessages: Message[] = compressState.summaries.map(s => ({
      role: 'system' as const,
      content: `[历史摘要 L${s.level} @ ${s.createdAt}]\n${s.text}`,
    }));
    appState.set('conversationHistory', [...summaryMessages, ...appState.get('conversationHistory')]);
    console.log(`[压缩] 已恢复 ${compressState.summaries.length} 层摘要`);
  }

  // ==================== Tab 补全 ====================

  /** Readline 补全函数：仅当输入以 / 开头时补全命令；其他情况不补全 */
  const completer = (line: string): [string[], string] => {
    if (!line.startsWith('/')) return [[], line];
    const parts = line.split(/\s+/);
    if (parts.length === 1) {
      // 补全主命令
      const hits = SLASH_COMMANDS
        .filter(c => c.name.startsWith(line))
        .map(c => c.name);
      return [hits, line];
    }
    // 补全子参数
    const cmdName = parts[0];
    const cmd = SLASH_COMMANDS.find(c => c.name === cmdName);
    if (!cmd || !cmd.subArgs) return [[], line];
    const argPrefix = parts[parts.length - 1];
    const hits = cmd.subArgs.filter(s => s.startsWith(argPrefix));
    return [hits, argPrefix];
  };

  /** 渲染斜杠命令提示（用户输入 / 后回车显示） */
  const showSlashHint = (): void => {
    console.log('\n可用斜杠命令:');
    for (const c of SLASH_COMMANDS) {
      const sub = c.subArgs ? ` ${c.subArgs.join(' | ')}` : '';
      console.log(`  ${c.name.padEnd(12)} ${c.description}${sub}`);
    }
    console.log('提示: 输入 / 后按 Tab 可补全命令\n');
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
    completer,
  });

  rl.prompt();

  rl.on('line', async (input) => {
    const trimmed = input.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === '/') {
      // 只输入 / 时显示可用命令提示
      showSlashHint();
      rl.prompt();
      return;
    }

    if (trimmed.startsWith('/')) {
      await handleSlashCommand(slashCtx, trimmed);
      rl.prompt();
      return;
    }

    try {
      await agentLoop(trimmed);
    } catch (error) {
      console.log(`[错误] ${error}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n再见！');
    process.exit(0);
  });

  // Ctrl+C 优雅退出：第一次提示，第二次强制退出
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount >= 2) {
      console.log('\n强制退出');
      process.exit(1);
    }
    console.log('\n按 Ctrl+C 再次退出，或继续输入');
    rl.prompt();
  });
}

main().catch(console.error);
