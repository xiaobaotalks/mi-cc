#!/usr/bin/env node
/**
 * mi-cc - 主入口
 * 技术栈: Node.js + TypeScript + Commander + fs + JSON
 * 功能: 终端对话、工具调用、四层记忆、上下文压缩、简易蒸馏
 */

import { Command } from 'commander';
import OpenAI from 'openai';
import {
  loadCompressState,
} from './compress';
import type { Message } from './types';
import {
  createBuiltinTools,
  toolRunShell,
} from './tools';
import {
  initMcpTools,
  type SlashContext,
} from './commands';
import { ProviderRouter, type ProviderConfig } from './src/router';
// 启动时自动加载上次激活的 Provider
import { loadProviders } from './commands';
import chalk from 'chalk';
import {
  readCheckpoint,
  initHistory,
  generateSessionId,
  readTaskCheckpoint,
  loadSessionIndex,
} from './memory';
import { mcpMode } from './mcp-mode';
import { appState } from './src/state';
import { loadConfig } from './src/config';

import { runAgent, handleToolCalls } from './src/agent';
import { startCLI } from './src/cli';
import {
  callLLM,
  callLLMSingle,
  handleContextLengthError,
  retryWithBackoff,
  buildSystemPrompt,
  compactContext,
  LLM_TIMEOUT_MS,
  LLM_MAX_RETRIES,
} from './src/llm-core';

// ==================== 全局变量 ====================

let slashCtx: SlashContext;
let router: ProviderRouter | null = null;

// 启动像素标识
// 注意：CJK 字符在终端占 2 列宽，源码只算 1 字符；排版时按 CJK 字符数 -1 计算空格
// 所有行（外框/内框/内容）终端列宽统一为 56
const BANNER = chalk.cyan(`
╔══════════════════════════════════════════════════════╗
║  ███╗   ███╗     ██████╗ ██████╗ ██████╗ ███████╗    ║
║  ████╗ ████║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝    ║
║  ██╔████╔██║    ██║     ██║   ██║██║  ██║█████╗      ║
║  ██║╚██╔╝██║    ██║     ██║   ██║██║  ██║██╔══╝      ║
║  ██║ ╚═╝ ██║    ╚██████╗╚██████╔╝██████╔╝███████╗    ║
║  ╚═╝     ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝    ║
╠══════════════════════════════════════════════════════╣
║  ▓▒░  ╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮  ░▒▓  ║
║  ▓▒░  ┃  mi-cc · 包催催个人定制 · v2.1.0     ┃  ░▒▓  ║
║  ▓▒░  ┃    智能编程助手 · LLM Agent Shell    ┃  ░▒▓  ║
║  ▓▒░  ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯  ░▒▓  ║
╚══════════════════════════════════════════════════════╝
`);

// ==================== 初始化 ====================

function initOpenAI(cfg: { apiKey: string; baseUrl: string }) {
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  });
}

// ==================== 主程序 ====================

async function main() {
  const program = new Command();
  program
    .name('mi-cc')
    .description('mi-cc - 智能编程助手 (MCP Server / CLI)')
    .version('2.1.0')
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

  // 首次运行检测：API Key 缺失或为占位符时引导配置
  if (!config.apiKey || config.apiKey === 'your_api_key_here') {
    console.log('┌──────────────────────────────────────────────────────────┐');
    console.log('│  ⚠  尚未配置 API Key                                    │');
    console.log('│                                                          │');
    console.log('│  请输入 /connect 启动配置向导，或直接输入：              │');
    console.log('│    /connect <你的API Key>                                │');
    console.log('│                                                          │');
    console.log('│  默认使用小米 MiMo 模型，也支持 OpenAI / Claude / GLM    │');
    console.log('└──────────────────────────────────────────────────────────┘\n');
  }

  let openai = initOpenAI(config);
  let historyData = initHistory();
  let tools = createBuiltinTools();
  initMcpTools(tools, (cmd, timeout) =>
    toolRunShell({ command: cmd, timeout }),
  );

  // 加载会话索引
  const sessionIndex = loadSessionIndex();
  if (sessionIndex.length > 0) {
    console.log(`[会话] 共 ${sessionIndex.length} 个历史会话`);
  }

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
  const checkpoint = readCheckpoint(options.session);
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

  // 恢复任务级 checkpoint
  const taskCheckpoint = readTaskCheckpoint(options.session);
  if (taskCheckpoint && taskCheckpoint.sessionId === currentSessionId) {
    console.log(`[任务] 恢复上次任务: ${taskCheckpoint.goal}`);
    if (taskCheckpoint.blockers.length > 0) {
      console.log(`[任务] 阻塞问题: ${taskCheckpoint.blockers.length} 个`);
      for (const b of taskCheckpoint.blockers) {
        console.log(`  - Step ${b.stepId}: ${b.reason}`);
      }
    }
    if (taskCheckpoint.modifiedFiles.length > 0) {
      console.log(`[任务] 已修改文件: ${taskCheckpoint.modifiedFiles.join(', ')}`);
    }
  }

  // 初始化 appState
  appState.init({
    openai,
    config,
    currentSessionId,
    conversationHistory: [],
    tools,
    historyData: initHistory(currentSessionId),
  });

  // 构建所有 Provider 配置（主 + 备用）
  const allProviders: ProviderConfig[] = [
    {
      id: 'primary',
      name: 'Primary',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    },
  ];
  const backupProviders = ProviderRouter.loadFromEnv();
  allProviders.push(...backupProviders);

  if (allProviders.length > 1) {
    router = new ProviderRouter(allProviders);
    appState.router = router;
    console.log(`[Provider] 已加载 ${allProviders.length} 个 Provider`);
  }

  // 构建斜杠命令上下文（直接引用 appState，消除双重状态）
  slashCtx = {
    get openai() { return appState.get('openai'); },
    set openai(v) { appState.set('openai', v); },
    get config() { return appState.get('config'); },
    set config(v) { appState.set('config', v); },
    get tools() { return appState.get('tools'); },
    set tools(v) { appState.set('tools', v); },
  };

  // 恢复压缩摘要层
  const compressState = loadCompressState(currentSessionId);
  if (compressState.summaries.length > 0) {
    const summaryMessages: Message[] = compressState.summaries.map((s: any) => ({
      role: 'system' as const,
      content: `[历史摘要 L${s.level} @ ${s.createdAt}]\n${s.text}`,
    }));
    appState.set('conversationHistory', [...summaryMessages, ...appState.get('conversationHistory')]);
    console.log(`[压缩] 已恢复 ${compressState.summaries.length} 层摘要`);
  }

  // 启动 CLI
  await startCLI({
    onUserInput: runAgent,
    slashCtx,
  });
}

main().catch(console.error);

// ==================== 导出（保持向后兼容） ====================

export {
  runAgent,
  handleToolCalls,
  callLLM,
  callLLMSingle,
  handleContextLengthError,
  retryWithBackoff,
  buildSystemPrompt,
  compactContext,
  LLM_TIMEOUT_MS,
  LLM_MAX_RETRIES,
};
