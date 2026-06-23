#!/usr/bin/env node
/**
 * mi-cc - 主入口
 * 技术栈: Node.js + TypeScript + Commander + fs + JSON
 * 功能: 终端对话、工具调用、四层记忆、上下文压缩、简易蒸馏
 */

import { Command } from 'commander';
import OpenAI from 'openai';
import * as https from 'https';
import {
  loadCompressState,
  resolveContextWindow,
} from './compress';
import type { Message } from './types';
import {
  createBuiltinTools,
  toolRunShell,
  loadUserAllowList,
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
import { loadConfig, isPlaceholderApiKey } from './src/config';

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
// 配色：大 M 保持小米橙，其余边框/文字用柔和灰
const orange = chalk.hex('#FF6900');
const soft = chalk.gray;

const BANNER = ''
  + soft('╔══════════════════════════════════════════════════════╗\n')
  + orange('║  ███╗   ███╗     ██████╗ ██████╗ ██████╗ ███████╗    ║\n')
  + orange('║  ████╗ ████║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝    ║\n')
  + orange('║  ██╔████╔██║    ██║     ██║   ██║██║  ██║█████╗      ║\n')
  + orange('║  ██║╚██╔╝██║    ██║     ██║   ██║██║  ██║██╔══╝      ║\n')
  + orange('║  ██║ ╚═╝ ██║    ╚██████╗╚██████╔╝██████╔╝███████╗    ║\n')
  + orange('║  ╚═╝     ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝    ║\n')
  + soft('╠══════════════════════════════════════════════════════╣\n')
  + soft('║  ▓▒░  ╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮  ░▒▓  ║\n')
  + soft('║  ▓▒░  ┃    ') + chalk.white('mi-cc · 为发烧而生 · v2.3.0') + soft('         ┃  ░▒▓  ║\n')
  + soft('║  ▓▒░  ┃    ') + chalk.white('智能编程助手 · LLM Agent Shell') + soft('      ┃  ░▒▓  ║\n')
  + soft('║  ▓▒░  ╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯  ░▒▓  ║\n')
  + soft('╚══════════════════════════════════════════════════════╝\n');

// ==================== 初始化 ====================

function initOpenAI(cfg: { apiKey: string; baseUrl: string }) {
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  });
}

// ==================== 版本检查 ====================

const CURRENT_VERSION = '2.3.0';

function fetchRemoteVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      'https://raw.githubusercontent.com/xiaobaotalks/mi-cc/main/package.json',
      { timeout: 3000 },
      (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const pkg = JSON.parse(data);
            resolve(pkg.version || null);
          } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function checkUpdate() {
  const remote = await fetchRemoteVersion();
  if (remote && compareVersions(remote, CURRENT_VERSION) > 0) {
    console.log(`┌──────────────────────────────────────────────────────────┐`);
    console.log(`│  📦 发现新版本 v${remote}（当前 v${CURRENT_VERSION}）${' '.repeat(Math.max(0, 28 - remote.length - CURRENT_VERSION.length))}│`);
    console.log(`│  运行 mi-cc update 即可一键更新                         │`);
    console.log(`└──────────────────────────────────────────────────────────┘\n`);
  }
}

// ==================== 主程序 ====================

async function main() {
  const program = new Command();
  program
    .name('mi-cc')
    .description('mi-cc - 智能编程助手 (MCP Server / CLI)')
    .version('2.3.0')
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

  // 非阻塞检查版本更新（不等待结果，不影响启动速度）
  checkUpdate().catch(() => {});

  const { config, warnings } = loadConfig();
  for (const w of warnings) console.log(`[警告] ${w}`);

  // 自动推断模型上下文窗口大小（如果 maxTokens 仍为默认值 8000）
  const resolvedWindow = resolveContextWindow(config.model);
  if (resolvedWindow && config.maxTokens === 8000) {
    config.maxTokens = resolvedWindow;
    console.log(`[配置] 模型 ${config.model} 上下文窗口: ${(resolvedWindow / 1024).toFixed(0)}K tokens`);
  } else if (!resolvedWindow) {
    console.log(`[配置] 未知模型 ${config.model}，使用默认 maxTokens=${config.maxTokens}`);
  }

  // 首次运行检测：API Key 缺失或为占位符时引导配置
  if (!config.apiKey || isPlaceholderApiKey(config.apiKey)) {
    console.log('┌──────────────────────────────────────────────────────────┐');
    console.log('│  ⚠  API Key 未配置或为占位符                              │');
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
  // 加载用户自定义命令允许列表（持久化在 .mi-cc-allow.json）
  loadUserAllowList();
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
