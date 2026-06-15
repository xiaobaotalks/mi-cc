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
  isContextLengthError,
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

// ==================== 常量 ====================

/** Agent 循环最大工具调用轮数，防止无限循环 */
const MAX_TOOL_ITERATIONS = 20;

// ==================== 全局变量 ====================

let openai: OpenAI;
let config: Config;
let currentSessionId: string;
let conversationHistory: Message[] = [];
let tools: Tool[] = [];
let historyData: HistoryRecord[] = [];
let slashCtx: SlashContext;

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
║  ▓▒░  ┃ ✦  【 为 发 烧 而 生 】  ✦  MiMo CLI ┃  ░▒▓  ║
║  ▓▒░  ┃    智能编程助手 · LLM Agent Shell    ┃  ░▒▓  ║
║  ▓▒░  ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯  ░▒▓  ║
╚══════════════════════════════════════════════════════╝
`;

// ==================== 初始化 ====================

function initConfig(): Config {
  dotenv.config({ path: '.env' });
  const model = process.env.MODEL || 'gpt-4o-mini';
  // 自动根据模型推断上下文窗口；用户可通过 MAX_TOKEN 显式覆盖
  const envMaxToken = process.env.MAX_TOKEN ? parseInt(process.env.MAX_TOKEN, 10) : null;
  const inferred = envMaxToken ?? resolveContextWindow(model) ?? 8000;
  if (envMaxToken === null && resolveContextWindow(model)) {
    console.log(`[配置] 模型 ${model} 自动设置 maxTokens=${inferred}`);
  }
  return {
    apiKey: process.env.API_KEY || '',
    baseUrl: process.env.BASE_URL || 'https://api.openai.com/v1',
    model,
    maxTokens: inferred,
  };
}

function initOpenAI(cfg: Config): OpenAI {
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  });
}

// ==================== 上下文压缩包装 ====================

async function compactContext(): Promise<void> {
  const result = await tieredCompact(
    openai,
    config.model,
    conversationHistory,
    config.maxTokens,
    (msg) => console.log(msg),
  );

  if (!result.changed) {
    if (result.tier === 'none') {
      const total = estimateTotalTokens(conversationHistory);
      console.log(`[压缩] 当前 token ${total}，无需压缩`);
    }
    return;
  }

  conversationHistory = result.messages;
  saveStateFromMessages(conversationHistory);
  console.log(`[压缩] 完成 (${result.tier})，当前 token ${estimateTotalTokens(conversationHistory)}`);
  appendNote(`上下文压缩完成（${result.tier}），剩余 token: ${estimateTotalTokens(conversationHistory)}`);
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
  // 有当前输入时跳过缓存（技能匹配结果因输入而异）
  if (systemPromptCache && systemPromptCache.mtime === mtime && !currentUserInput) {
    return systemPromptCache.prompt;
  }

  const memory = readMemory();
  const notes = readNotes();
  const checkpoint = readCheckpoint();
  const skillLib = fs.existsSync(SKILL_LIB_FILE) ? fs.readFileSync(SKILL_LIB_FILE, 'utf-8') : '';

  let systemPrompt = `你是一个智能编程助手 MiMo Code CLI。

## 当前会话
- Session ID: ${currentSessionId}
- 时间: ${new Date().toISOString()}

## 可用工具
${tools.map(t => `- ${t.name}: ${t.description}${t.source === 'mcp' ? ' (MCP)' : ''}`).join('\n')}

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

async function callLLM(messages: Message[]): Promise<Message> {
  try {
    const response = await openai.chat.completions.create({
      model: config.model,
      messages: messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: toolsToOpenAIFormat(tools),
      tool_choice: 'auto',
      max_tokens: config.maxTokens,
    });

    const choice = response.choices[0];
    // OpenAI SDK 返回的 message 已含 role/content/tool_calls，直接使用
    // Message.tool_calls 与 ChatCompletionMessage.tool_calls 类型兼容
    return choice.message as unknown as Message;
  } catch (error) {
    // 上下文超限时：自动压缩并降级 maxTokens 后重试一次
    if (isContextLengthError(error)) {
      console.log(`[LLM] 触发上下文超限，自动压缩并降级重试...`);
      // 用更激进的 maxTokens（当前 90%）重试
      const reducedMax = Math.floor(config.maxTokens * 0.9);
      config.maxTokens = reducedMax;
      appendNote(`[LLM] 上下文超限，已将 maxTokens 降至 ${reducedMax}`);
      // 强制一次压缩
      const result = await tieredCompact(
        openai,
        config.model,
        conversationHistory,
        reducedMax,
        (msg) => console.log(msg),
      );
      if (result.changed) {
        conversationHistory = result.messages;
        saveStateFromMessages(conversationHistory);
      }
      // 用压缩后的 history 重试一次
      const retryMessages: Message[] = [
        { role: 'system', content: buildSystemPrompt() },
        ...conversationHistory,
      ];
      const retry = await openai.chat.completions.create({
        model: config.model,
        messages: retryMessages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: toolsToOpenAIFormat(tools),
        tool_choice: 'auto',
        max_tokens: reducedMax,
      });
      return retry.choices[0].message as unknown as Message;
    }
    throw new Error(`LLM 调用失败: ${error}`);
  }
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
    const result = await executeToolCall(tools, toolName, args);
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
      sessionId: currentSessionId,
      task: conversationHistory.filter(m => m.role === 'user').pop()?.content?.substring(0, 100) || '',
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
  conversationHistory.push({ role: 'user', content: userInput });
  historyData = saveHistory(historyData, currentSessionId, 'user', userInput);

  await compactContext();

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(userInput) },
    ...conversationHistory,
  ];

  let response = await callLLM(messages);

  let iterations = 0;
  while (true) {
    conversationHistory.push(response);
    historyData = saveHistory(historyData, currentSessionId, 'assistant', response.content || JSON.stringify(response));

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
      conversationHistory.push({
        role: 'tool',
        content: results[i],
        tool_call_id: toolCalls[i].id,
      });
    }

    const nextMessages: Message[] = [
      { role: 'system', content: buildSystemPrompt() },
      ...conversationHistory,
    ];
    response = await callLLM(nextMessages);
  }

  writeCheckpoint({
    sessionId: currentSessionId,
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
    .name('mimo-cli')
    .description('MiMo Code CLI - 最简化版智能编程助手')
    .version('1.0.0')
    .option('-s, --session <id>', '指定会话 ID')
    .parse(process.argv);

  const options = program.opts();

  console.log(BANNER);
  console.log('输入 /help 查看可用命令\n');

  config = initConfig();
  openai = initOpenAI(config);
  historyData = initHistory();
  tools = createBuiltinTools();
  initMcpTools(tools, (cmd, timeout) =>
    toolRunShell({ command: cmd, timeout }),
  );

  // 构建斜杠命令上下文
  slashCtx = {
    openai,
    config,
    tools,
    conversationHistory,
    historyData,
    currentSessionId: '',
  };
  // 同步上下文辅助函数：将全局变量同步到 SlashContext
  const syncCtx = () => {
    slashCtx.openai = openai;
    slashCtx.config = config;
    slashCtx.tools = tools;
    slashCtx.conversationHistory = conversationHistory;
    slashCtx.historyData = historyData;
    slashCtx.currentSessionId = currentSessionId;
  };

  // 恢复或创建会话
  const checkpoint = readCheckpoint();
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
  syncCtx();

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
      syncCtx();
      await handleSlashCommand(slashCtx, trimmed);
      // 从上下文回写可能被命令修改的状态
      conversationHistory = slashCtx.conversationHistory;
      historyData = slashCtx.historyData;
      config = slashCtx.config;
      openai = slashCtx.openai;
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
