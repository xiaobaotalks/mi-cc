/**
 * 斜杠命令处理：/connect /compact /distill /dream /skill /tools /help /exit
 * 所有命令通过 SlashContext 获取/修改运行时状态
 */

import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import type { Message, Tool, HistoryRecord, Config } from './types';
import { appState } from './src/state';
import {
  tieredCompact,
  estimateTotalTokens,
  saveStateFromMessages,
} from './compress';
import { loadSkills, reloadSkills } from './skills';
import { loadMcpTools } from './mcp';
import { ProviderRouter, type ProviderConfig } from './src/router';
import {
  addUserAllowedCommand,
  removeUserAllowedCommand,
  getUserAllowList,
} from './tools';
import {
  readCheckpoint,
  readMemory,
  queryHistory,
  saveHistoryToFile,
  MEMORY_FILE,
  SKILL_LIB_FILE,
  readTaskCheckpoint,
  writeTaskCheckpoint,
  createTaskCheckpoint,
  loadSessionIndex,
  saveSessionIndex,
  addOrUpdateSession,
  removeSession,
} from './memory';
import { renderSuccess, renderError, renderWarning, renderInfo } from './src/ui';
import { scanProject, loadIndex, searchIndex } from './src/indexer';
import { callLLM } from './src/llm-core';

// ==================== 上下文接口 ====================

/** 斜杠命令共享的运行时上下文 */
export interface SlashContext {
  openai: OpenAI;
  config: Config;
  tools: Tool[];
}

// ==================== /connect ====================

import * as readline from 'readline';

/** REPL 的 readline 接口（由 cli.ts 设置，交互式向导复用，避免 stdin 冲突） */
let replRl: readline.Interface | null = null;

/** 设置 REPL 的 readline 接口，供交互式向导复用 */
export function setReplReadline(rl: readline.Interface): void {
  replRl = rl;
}

/** 重建 ProviderRouter 并同步到 appState（切换 Provider 后必须调用） */
function rebuildRouter(ctx: SlashContext): void {
  const allProviders: ProviderConfig[] = [
    {
      id: 'primary',
      name: 'Primary',
      apiKey: ctx.config.apiKey,
      baseUrl: ctx.config.baseUrl,
      model: ctx.config.model,
    },
  ];
  const backupProviders = ProviderRouter.loadFromEnv();
  allProviders.push(...backupProviders);

  if (allProviders.length > 1) {
    const newRouter = new ProviderRouter(allProviders);
    appState.router = newRouter;
    console.log(`[Provider] 已重建路由 (${allProviders.length} 个 Provider)`);
  } else {
    appState.router = null;
  }
}

/** 合并写入 .env：只覆盖指定 key，保留其他 key 不变 */
function mergeEnvFile(updates: Record<string, string>): void {
  const envPath = '.env';
  let existing: Record<string, string> = {};

  // 读取已有 .env
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        existing[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
      }
    }
  }

  // 合并更新
  Object.assign(existing, updates);

  // 写回
  const lines = Object.entries(existing).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');
}

/** 预置的模型配置模板 */
const PRESET_PROVIDERS = [
  {
    name: '小米 MiMo (推荐)',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro', 'mimo-v2-omni'],
  },
  {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'],
  },
  {
    name: '月之暗面 Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
  },
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  },
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  },
  {
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
  },
  {
    name: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  {
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    models: [],
  },
];

// ========== 安全存储（可选功能） ==========

/**
 * 尝试使用系统 keychain 存储 API Key
 * 支持: macOS Keychain / Windows Credential Store / Linux libsecret
 * 如果不可用则回退到 .env 明文存储
 */
async function safeStoreApiKey(service: string, account: string, key: string): Promise<boolean> {
  try {
    // @ts-ignore - keytar 为可选依赖，运行时动态加载
    const keytar = await import('keytar');
    await keytar.setPassword(service, account, key);
    return true;
  } catch {
    // keytar 不可用
    return false;
  }
}

async function safeGetApiKey(service: string, account: string): Promise<string | null> {
  try {
    // @ts-ignore - keytar 为可选依赖，运行时动态加载
    const keytar = await import('keytar');
    return await keytar.getPassword(service, account);
  } catch {
    return null;
  }
}

/** 创建交互式输入 */
function createPrompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/** 交互式配置向导 */
async function interactiveConnect(ctx: SlashContext): Promise<void> {
  // 复用 REPL 的 readline，避免两个 readline 同时监听 stdin 导致输入冲突
  const rl = replRl || readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const shouldClose = !replRl;  // 只有自建的 readline 才需要关闭

  try {
    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                  mi-cc API 配置向导                            ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');

    // 显示当前配置
    console.log('📋 当前配置:');
    console.log(`   API Key: ${ctx.config.apiKey ? '✅ 已设置' : '❌ 未设置'}`);
    console.log(`   Base URL: ${ctx.config.baseUrl}`);
    console.log(`   Model: ${ctx.config.model}`);
    console.log(`   Max Tokens: ${ctx.config.maxTokens}\n`);

    // 选择供应商
    console.log('请选择模型供应商:');
    PRESET_PROVIDERS.forEach((p, i) => {
      const marker = p.baseUrl === ctx.config.baseUrl ? ' (当前)' : '';
      console.log(`  ${i + 1}. ${p.name}${marker}`);
    });

    const providerIdx = await createPrompt(rl, '\n输入序号 (1-' + PRESET_PROVIDERS.length + '): ');
    const idx = parseInt(providerIdx, 10) - 1;
    const provider = PRESET_PROVIDERS[idx] || PRESET_PROVIDERS[0];

    // 输入 API Key（按 Enter 保留当前值）
    const apiKeyInput = await createPrompt(rl, `请输入 API Key (按 Enter 保留当前值): `);
    const apiKey = apiKeyInput || ctx.config.apiKey;
    if (!apiKey) {
      renderError('API Key 不能为空，配置取消');
      return;
    }

    // 自定义 Base URL
    let baseUrl = provider.baseUrl;
    if (provider.name === '自定义' || !provider.baseUrl) {
      const customUrl = await createPrompt(rl, `请输入 Base URL (默认: ${ctx.config.baseUrl}): `);
      baseUrl = customUrl || ctx.config.baseUrl;
    }

    // 选择模型
    let model = provider.models[0] || ctx.config.model;
    if (provider.models.length > 0) {
      console.log('\n可用模型:');
      provider.models.forEach((m, i) => {
        const marker = m === ctx.config.model ? ' (当前)' : '';
        console.log(`  ${i + 1}. ${m}${marker}`);
      });
      const modelIdx = await createPrompt(rl, '输入序号 (或按 Enter 使用第一个): ');
      if (modelIdx) {
        const selected = provider.models[parseInt(modelIdx, 10) - 1];
        if (selected) model = selected;
      }
    } else {
      const customModel = await createPrompt(rl, `请输入模型名称 (默认: ${ctx.config.model}): `);
      if (customModel) model = customModel;
    }

    // 确认配置
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│                      配置预览                                │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│ 供应商: ${provider.name.padEnd(49)}│`);
    console.log(`│ API Key: ${'*'.repeat(Math.min(apiKey.length, 20)).padEnd(48)}│`);
    console.log(`│ Base URL: ${baseUrl.padEnd(48)}│`);
    console.log(`│ Model: ${model.padEnd(51)}│`);
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    const confirm = await createPrompt(rl, '确认保存? (Y/n): ');
    if (confirm.toLowerCase() === 'n') {
      renderError('配置已取消');
      return;
    }

    // 询问是否启用安全存储
    const useSafeStorage = await createPrompt(
      rl,
      '\n是否启用安全存储？(将 Key 加密存储而非明文 .env) (y/N): '
    );

    let apiKeyToStore = apiKey;
    if (useSafeStorage.toLowerCase() === 'y') {
      const stored = await safeStoreApiKey('mi-cc', provider.name, apiKey);
      if (stored) {
        // 从 .env 中移除 API Key，替换为占位符
        apiKeyToStore = '[SECURED]';
        renderSuccess('API Key 已加密存储');
      } else {
        renderWarning('安全存储不可用，Key 已明文保存到 .env');
      }
    }

    // 应用配置（ctx.config.apiKey 保留实际 Key 供 API 调用使用）
    ctx.config.apiKey = apiKey;
    ctx.config.baseUrl = baseUrl;
    ctx.config.model = model;

    ctx.openai = new OpenAI({
      apiKey: ctx.config.apiKey,
      baseURL: ctx.config.baseUrl,
    });

    // 同步到 appState
    appState.set('config', ctx.config);
    appState.set('openai', ctx.openai);

    // 保存到 .env（如果启用安全存储则写入占位符）
    mergeEnvFile({
      API_KEY: apiKeyToStore,
      BASE_URL: ctx.config.baseUrl,
      MODEL: ctx.config.model,
    });

    renderSuccess('配置已更新并保存到 .env');
    renderInfo('当前使用:', `${provider.name} / ${model}`);

    // 重建故障转移路由器
    rebuildRouter(ctx);

    // 测试连接
    renderInfo('正在测试连接...', '');
    try {
      const testResponse = await ctx.openai.chat.completions.create({
        model: ctx.config.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
      });
      renderSuccess('连接测试成功!');
    } catch (error) {
      renderWarning(`连接测试失败: ${(error as Error).message}`);
      renderInfo('提示:', '配置已保存，但请检查 API Key 和 Base URL 是否正确');
    }

  } finally {
    if (shouldClose) rl.close();
  }
}

async function handleConnect(ctx: SlashContext, args: string[]): Promise<void> {
  // 子命令：list 显示当前配置
  if (args.length === 1 && args[0] === 'list') {
    console.log('[配置] 当前配置:');
    console.log(`  API Key: ${ctx.config.apiKey ? ctx.config.apiKey.substring(0, 8) + '...' : '未设置'}`);
    console.log(`  Base URL: ${ctx.config.baseUrl}`);
    console.log(`  Model: ${ctx.config.model}`);
    console.log(`  Max Tokens: ${ctx.config.maxTokens}`);
    return;
  }

  // 如果有参数，走快捷模式
  if (args.length > 0) {
    // 检测第一个参数是否像 API Key（以字母数字开头，且长度 > 5）
    const firstArg = args[0];
    const looksLikeApiKey = /^[a-zA-Z0-9_\-]/.test(firstArg) && firstArg.length > 5;

    if (!looksLikeApiKey) {
      // 可能是供应商名称（如"小米"）或误输入，走交互式向导
      renderWarning(`"${firstArg}" 不是有效的 API Key，已启动交互式向导`);
      try {
        await interactiveConnect(ctx);
      } catch (err) {
        console.log(`[配置向导] 错误: ${err}`);
      }
      return;
    }

    ctx.config.apiKey = firstArg;
    if (args[1]) ctx.config.baseUrl = args[1];
    if (args[2]) ctx.config.model = args[2];

    ctx.openai = new OpenAI({
      apiKey: ctx.config.apiKey,
      baseURL: ctx.config.baseUrl,
    });

    // 同步到 appState
    appState.set('config', ctx.config);
    appState.set('openai', ctx.openai);

    mergeEnvFile({
      API_KEY: ctx.config.apiKey,
      BASE_URL: ctx.config.baseUrl,
      MODEL: ctx.config.model,
    });
    console.log('配置已更新并保存');
    return;
  }

  // 无参数时启动交互式向导（必须 await，否则 REPL 会与向导的 readline 冲突）
  try {
    await interactiveConnect(ctx);
  } catch (err) {
    console.log(`[配置向导] 错误: ${err}`);
  }
}

// ==================== /compact ====================

async function handleCompact(ctx: SlashContext): Promise<void> {
  console.log('[手动压缩] 开始...');
  const beforeTokens = estimateTotalTokens(appState.get('conversationHistory'));

  const forcedMax = Math.max(Math.ceil(beforeTokens * 1.5), ctx.config.maxTokens);
  const result = await tieredCompact(
    ctx.openai,
    ctx.config.model,
    appState.get('conversationHistory'),
    forcedMax,
    (msg) => console.log(msg),
  );

  if (result.changed) {
    appState.set('conversationHistory', result.messages);
    saveStateFromMessages(appState.get('conversationHistory'), appState.get('currentSessionId'));
    const afterTokens = estimateTotalTokens(appState.get('conversationHistory'));
    console.log(`[手动压缩] 完成 (${result.tier}): ${beforeTokens} -> ${afterTokens} tokens`);
  } else {
    console.log('[手动压缩] 没有可压缩的历史');
  }
}

// ==================== /distill ====================

async function handleDistill(ctx: SlashContext): Promise<void> {
  console.log('[蒸馏] 开始经验蒸馏...');

  const checkpoint = readCheckpoint(appState.get('currentSessionId'));
  const memory = readMemory();
  const history = queryHistory(appState.get('historyData'), appState.get('currentSessionId'));

  const distillPrompt = `请分析以下数据，挖掘高频重复工作流，生成技能库。

## 检查点
${JSON.stringify(checkpoint, null, 2)}

## 项目记忆
${memory}

## 历史记录 (最近50条)
${history.slice(0, 50).map(h => `[${h.role}]: ${h.content}`).join('\n')}

请输出技能库，格式如下：
## 技能名称
- 步骤1: 描述
- 步骤2: 描述
- 命令: 相关命令
- 适用场景: 描述

请挖掘至少3个技能：`;

  try {
    const response = await ctx.openai.chat.completions.create({
      model: ctx.config.model,
      messages: [{ role: 'user', content: distillPrompt }],
      max_tokens: 2000,
    });

    const skillLib = response.choices[0]?.message?.content || '';
    fs.writeFileSync(SKILL_LIB_FILE, `# 技能库\n\n生成时间: ${new Date().toISOString()}\n\n${skillLib}`, 'utf-8');
    reloadSkills();

    console.log('[蒸馏] 完成，已生成 skill-lib.md');
    console.log(skillLib);
  } catch (error) {
    console.log(`[蒸馏] 失败: ${error}`);
  }
}

// ==================== /dream ====================

async function handleDream(ctx: SlashContext): Promise<void> {
  console.log('[Dream] 开始记忆整理...');

  let memory = readMemory();

  const dreamPrompt = `请整理以下项目记忆，要求：
1. 去重: 删除重复内容
2. 精简: 保留核心信息
3. 合并: 合并同类记录
4. 清理: 删除过期信息

当前记忆：
${memory}

请输出整理后的记忆（保持原有章节结构）：`;

  try {
    const response = await ctx.openai.chat.completions.create({
      model: ctx.config.model,
      messages: [{ role: 'user', content: dreamPrompt }],
      max_tokens: 2000,
    });

    const cleanedMemory = response.choices[0]?.message?.content || memory;
    fs.writeFileSync(MEMORY_FILE, cleanedMemory, 'utf-8');

    console.log('[Dream] 记忆整理完成');

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const beforeCount = appState.get('historyData').length;
    appState.set('historyData', appState.get('historyData').filter(r => r.time >= sevenDaysAgo));
    saveHistoryToFile(appState.get('historyData'), appState.get('currentSessionId'));
    console.log(`[Dream] 过期日志已清理: ${beforeCount} -> ${appState.get('historyData').length}`);
  } catch (error) {
    console.log(`[Dream] 失败: ${error}`);
  }
}

// ==================== /skill ====================

function handleSkillCommand(args: string[]): void {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const skills = loadSkills();
    if (skills.length === 0) {
      console.log('[Skill] 当前技能库为空。先运行 /distill 生成。');
      return;
    }
    console.log(`[Skill] 共 ${skills.length} 个技能：`);
    for (const s of skills) {
      console.log(`  - ${s.name}  (${s.scenario || '无适用场景'})`);
    }
    console.log('\n使用 /skill <name> 查看详情，/skill reload 强制重载。');
    return;
  }

  if (sub === 'reload') {
    reloadSkills();
    console.log('[Skill] 已重载技能库');
    return;
  }

  const skills = loadSkills();
  const target = skills.find(s => s.name === sub);
  if (!target) {
    console.log(`[Skill] 未找到技能: ${sub}`);
    return;
  }
  console.log(`\n## ${target.name}`);
  if (target.scenario) console.log(`适用场景: ${target.scenario}`);
  if (target.steps.length) {
    console.log('步骤:');
    target.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }
  if (target.commands.length) {
    console.log('命令:');
    target.commands.forEach(c => console.log(`  $ ${c}`));
  }
}

// ==================== /provider ====================

/** Provider 配置持久化文件 */
const PROVIDER_FILE = 'providers.json';

export interface ProviderEntry {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  active: boolean;
}

export function loadProviders(): ProviderEntry[] {
  try {
    if (fs.existsSync(PROVIDER_FILE)) {
      return JSON.parse(fs.readFileSync(PROVIDER_FILE, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return [];
}

function saveProviders(providers: ProviderEntry[]): void {
  fs.writeFileSync(PROVIDER_FILE, JSON.stringify(providers, null, 2), 'utf-8');
}

function getActiveProvider(providers: ProviderEntry[]): ProviderEntry | null {
  return providers.find(p => p.active) || providers[0] || null;
}

function handleProviderCommand(ctx: SlashContext, args: string[]): void {
  const sub = args[0] || 'list';
  const providers = loadProviders();

  switch (sub) {
    case 'list': {
      if (providers.length === 0) {
        console.log('[Provider] 暂无已保存的 Provider');
        console.log('提示: 使用 /connect 配置后，可用 /provider save <name> 保存');
        return;
      }
      console.log(`[Provider] 共 ${providers.length} 个配置：`);
      for (const p of providers) {
        const active = p.active ? ' ● 当前' : '';
        const keyHint = p.apiKey ? `(${p.apiKey.slice(0, 8)}...)` : '(无 key)';
        console.log(`  ${p.id === getActiveProvider(providers)?.id ? '▸' : ' '} ${p.name} ${keyHint} / ${p.model}${active}`);
      }
      console.log('\n用法: /provider switch <id>  切换');
      console.log('      /provider save <name>   保存当前配置');
      console.log('      /provider remove <id>   删除');
      return;
    }

    case 'save': {
      const name = args[1] || ctx.config.model;
      // 新保存的 Provider 默认设为 active，之前的全部取消 active
      for (const p of providers) {
        p.active = false;
      }
      const entry: ProviderEntry = {
        id: `p_${Date.now()}`,
        name,
        apiKey: ctx.config.apiKey,
        baseUrl: ctx.config.baseUrl,
        model: ctx.config.model,
        active: true,
      };
      providers.push(entry);
      saveProviders(providers);
      console.log(`[Provider] 已保存并激活: ${name} (${ctx.config.model})`);
      return;
    }

    case 'switch': {
      const targetId = args[1];
      if (!targetId) {
        console.log('[Provider] 用法: /provider switch <id>');
        return;
      }
      const target = providers.find(p => p.id === targetId || p.name === targetId);
      if (!target) {
        console.log(`[Provider] 未找到: ${targetId}`);
        return;
      }
      // 切换 active 状态
      for (const p of providers) p.active = false;
      target.active = true;
      saveProviders(providers);

      // 应用配置
      ctx.config.apiKey = target.apiKey;
      ctx.config.baseUrl = target.baseUrl;
      ctx.config.model = target.model;
      ctx.openai = new OpenAI({
        apiKey: target.apiKey,
        baseURL: target.baseUrl,
      });

      // 同步到 appState
      appState.set('config', ctx.config);
      appState.set('openai', ctx.openai);

      // 同步到 .env
      mergeEnvFile({
        API_KEY: target.apiKey,
        BASE_URL: target.baseUrl,
        MODEL: target.model,
      });

      // 重建故障转移路由器
      rebuildRouter(ctx);

      console.log(`[Provider] 已切换到: ${target.name} (${target.model})`);
      return;
    }

    case 'remove': {
      const removeId = args[1];
      if (!removeId) {
        console.log('[Provider] 用法: /provider remove <id>');
        return;
      }
      const idx = providers.findIndex(p => p.id === removeId || p.name === removeId);
      if (idx === -1) {
        console.log(`[Provider] 未找到: ${removeId}`);
        return;
      }
      const removed = providers.splice(idx, 1)[0];
      saveProviders(providers);
      console.log(`[Provider] 已删除: ${removed.name}`);
      return;
    }

    default:
      console.log(`[Provider] 未知子命令: ${sub}`);
      console.log('用法: /provider list | save <name> | switch <id> | remove <id>');
  }
}

// ==================== /window ====================

function handleWindowCommand(args: string[]): void {
  const sub = args[0] || 'status';
  if (sub === 'status') {
    const raw = appState.getRawMessages();
    const summaries = appState.getSummaryMessages();
    console.log(`[窗口] 原始消息: ${raw.length} 条 (上限: ${appState.maxRawTurns * 2})`);
    console.log(`[窗口] 摘要层: ${summaries.length} 层`);
    console.log(`[窗口] 总消息: ${appState.get('conversationHistory').length} 条`);
  }
  if (sub === 'set') {
    const n = parseInt(args[1], 10);
    if (n > 0) {
      appState.maxRawTurns = n;
      console.log(`[窗口] 已设置最大原始轮数为 ${n}`);
    } else {
      console.log('[窗口] 用法: /window set <正整数>');
    }
  }
}

// ==================== /task ====================

function handleTaskCommand(args: string[]): void {
  const sub = args[0] || 'status';
  const taskCheckpoint = readTaskCheckpoint(appState.get('currentSessionId'));
  if (!taskCheckpoint) {
    console.log('[任务] 无活动任务');
    return;
  }
  if (sub === 'status') {
    console.log(`[任务] ${taskCheckpoint.goal}`);
    console.log(`  进度: ${taskCheckpoint.currentStep}/${taskCheckpoint.totalSteps}`);
    console.log(`  修改文件: ${taskCheckpoint.modifiedFiles.length} 个`);
    console.log(`  阻塞: ${taskCheckpoint.blockers.length} 个`);
  }
  if (sub === 'steps') {
    for (const s of taskCheckpoint.steps) {
      const icon = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '○';
      console.log(`  ${icon} Step ${s.id}: ${s.description}`);
    }
  }
  if (sub === 'reset') {
    writeTaskCheckpoint(createTaskCheckpoint(appState.get('currentSessionId'), '新任务'), appState.get('currentSessionId'));
    console.log('[任务] 已重置');
  }
}

// ==================== /session ====================

function handleSessionCommand(args: string[]): void {
  const sub = args[0] || 'list';

  if (sub === 'list') {
    const index = loadSessionIndex();
    if (index.length === 0) {
      console.log('[会话] 暂无历史会话');
      return;
    }
    console.log(`[会话] 共 ${index.length} 个：`);
    for (const s of index) {
      const active = s.id === appState.get('currentSessionId') ? ' ● 当前' : '';
      console.log(`  ${s.id} | ${s.task.substring(0, 30)}... | ${s.messageCount} 条 | ${s.lastActiveAt.substring(0, 10)}${active}`);
    }
    return;
  }

  if (sub === 'switch') {
    const id = args[1];
    if (!id) {
      console.log('[会话] 用法: /session switch <id>');
      return;
    }
    appState.switchSession(id);
    console.log(`[会话] 已切换到: ${id}`);
    return;
  }

  if (sub === 'new') {
    const task = args.slice(1).join(' ') || '新会话';
    const id = `s_${Date.now()}`;
    appState.switchSession(id);
    addOrUpdateSession(id, task, 0);
    console.log(`[会话] 已创建: ${id}`);
    return;
  }

  if (sub === 'rename') {
    const id = args[1];
    const task = args.slice(2).join(' ');
    if (!id || !task) {
      console.log('[会话] 用法: /session rename <id> <新名称>');
      return;
    }
    const index = loadSessionIndex();
    const s = index.find(entry => entry.id === id);
    if (s) {
      s.task = task;
      saveSessionIndex(index);
      console.log(`[会话] 已重命名: ${id} → ${task}`);
    } else {
      console.log(`[会话] 未找到: ${id}`);
    }
    return;
  }

  if (sub === 'remove') {
    const id = args[1];
    if (!id) {
      console.log('[会话] 用法: /session remove <id>');
      return;
    }
    if (removeSession(id)) {
      console.log(`[会话] 已删除: ${id}`);
    } else {
      console.log(`[会话] 未找到: ${id}`);
    }
    return;
  }

  console.log(`[会话] 未知子命令: ${sub}`);
  console.log('用法: /session list | switch <id> | new [名称] | rename <id> <名称> | remove <id>');
}

// ==================== /tools ====================

function handleToolsCommand(ctx: SlashContext): void {
  console.log(`[Tools] 共 ${ctx.tools.length} 个工具：`);
  for (const t of ctx.tools) {
    const tag = t.source === 'mcp' ? ' (MCP)' : '';
    console.log(`  - ${t.name}${tag}: ${t.description}`);
  }
}

// ==================== 路由 ====================

/** 解析命令输入，支持双引号包裹的参数（路径含空格等场景） */
function parseCommandInput(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === '"') {
      // 遇到引号：切换引号状态，不将引号本身加入 current
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === ' ' && !inQuotes) {
      // 引号外的空格：分隔参数
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  // 最后一个参数
  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

/** 处理所有斜杠命令，返回 true 表示已处理 */
export async function handleSlashCommand(ctx: SlashContext, input: string): Promise<boolean> {
  const parts = parseCommandInput(input.trim());
  const command = parts[0];
  const args = parts.slice(1);

  switch (command) {
    case '/connect':
      await handleConnect(ctx, args);
      return true;

    case '/compact':
      await handleCompact(ctx);
      return true;

    case '/distill':
      await handleDistill(ctx);
      return true;

    case '/dream':
      await handleDream(ctx);
      return true;

    case '/skill':
      handleSkillCommand(args);
      return true;

    case '/provider':
      handleProviderCommand(ctx, args);
      return true;

    case '/model': {
      // /model              - 查看当前模型
      // /model <模型名>      - 快速切换模型
      // /model list          - 列出当前供应商的所有模型
      if (args.length === 0) {
        console.log(`[模型] 当前: ${ctx.config.model}`);
        console.log('  用法: /model <模型名> 切换，/model list 列出可用模型');
        return true;
      }
      if (args[0] === 'list') {
        // 根据当前 baseUrl 找到匹配的供应商
        const matched = PRESET_PROVIDERS.find(p => p.baseUrl === ctx.config.baseUrl);
        if (matched && matched.models.length > 0) {
          console.log(`[模型] ${matched.name} 可用模型:`);
          matched.models.forEach((m, i) => {
            const marker = m === ctx.config.model ? ' ← 当前' : '';
            console.log(`  ${i + 1}. ${m}${marker}`);
          });
          console.log('  切换: /model <模型名>');
        } else {
          console.log('[模型] 当前供应商无预置模型列表，请直接输入模型名');
          console.log('  切换: /model <模型名>');
        }
        return true;
      }
      // 切换模型
      const newModel = args[0];
      const oldModel = ctx.config.model;
      ctx.config.model = newModel;
      ctx.openai = new OpenAI({
        apiKey: ctx.config.apiKey,
        baseURL: ctx.config.baseUrl,
      });
      appState.set('config', ctx.config);
      appState.set('openai', ctx.openai);
      // 保存到 .env
      mergeEnvFile({
        API_KEY: ctx.config.apiKey,
        BASE_URL: ctx.config.baseUrl,
        MODEL: ctx.config.model,
      });
      // 更新上下文窗口
      const { resolveContextWindow } = await import('./compress');
      const resolvedWindow = resolveContextWindow(newModel);
      if (resolvedWindow) {
        ctx.config.maxTokens = resolvedWindow;
        console.log(`[模型] ${oldModel} → ${newModel} (上下文: ${(resolvedWindow / 1024).toFixed(0)}K)`);
      } else {
        console.log(`[模型] ${oldModel} → ${newModel}`);
      }
      return true;
    }

    case '/window':
      handleWindowCommand(args);
      return true;

    case '/task':
      handleTaskCommand(args);
      return true;

    case '/session':
      handleSessionCommand(args);
      return true;

    case '/tools':
      handleToolsCommand(ctx);
      return true;

    case '/allow': {
      // /allow              - 查看当前用户允许列表
      // /allow <cmd>        - 添加命令到允许列表
      // /allow remove <cmd> - 从允许列表移除
      if (args.length === 0) {
        const list = getUserAllowList();
        if (list.length === 0) {
          console.log('[授权] 用户自定义允许列表为空');
          console.log('  用法: /allow <命令名> 添加，/allow remove <命令名> 移除');
        } else {
          console.log(`[授权] 用户自定义允许列表 (${list.length} 项):`);
          for (const c of list) {
            console.log(`  - ${c}`);
          }
        }
      } else if (args[0] === 'remove' && args[1]) {
        if (removeUserAllowedCommand(args[1])) {
          console.log(`[授权] 已移除: ${args[1]}`);
        } else {
          console.log(`[授权] 不在列表中: ${args[1]}`);
        }
      } else {
        addUserAllowedCommand(args[0]);
        console.log(`[授权] 已添加: ${args[0]}`);
      }
      return true;
    }

    case '/image': {
      // /image <路径>              - 添加图片到下一次对话
      // /image <路径> <文本提示>    - 添加图片并立即发送带图片的消息
      // /image list                - 查看待发送图片
      // /image clear               - 清空待发送图片
      if (args.length === 0) {
        console.log('[图片] 用法:');
        console.log('  /image <图片路径>              添加图片，稍后输入文本时发送');
        console.log('  /image <图片路径> <文本提示>    添加图片并立即发送');
        console.log('  /image list                    查看待发送图片');
        console.log('  /image clear                   清空待发送图片');
        console.log('  支持格式: png, jpg/jpeg, gif, webp, bmp');
        return true;
      }
      if (args[0] === 'list') {
        const pending = appState.get('pendingImages');
        if (pending.length === 0) {
          console.log('[图片] 当前无待发送图片');
        } else {
          console.log(`[图片] 待发送 ${pending.length} 张:`);
          for (const img of pending) {
            console.log(`  - ${img.path} (${img.mimeType})`);
          }
        }
        return true;
      }
      if (args[0] === 'clear') {
        appState.set('pendingImages', []);
        console.log('[图片] 已清空待发送图片');
        return true;
      }
      // 添加图片
      const imgPath = args[0];
      // 剩余参数作为文本提示（可选）
      const textPrompt = args.slice(1).join(' ').trim();
      try {
        if (!fs.existsSync(imgPath)) {
          console.log(`[图片] 错误: 文件不存在 ${imgPath}`);
          return true;
        }
        const ext = path.extname(imgPath).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
        };
        const mimeType = mimeMap[ext];
        if (!mimeType) {
          console.log(`[图片] 错误: 不支持的图片格式 ${ext}，支持 png/jpg/gif/webp/bmp`);
          return true;
        }
        const buffer = fs.readFileSync(imgPath);
        const base64 = buffer.toString('base64');
        const pending = appState.get('pendingImages');
        pending.push({ path: imgPath, base64, mimeType });
        appState.set('pendingImages', pending);
        const sizeKb = (buffer.length / 1024).toFixed(1);
        console.log(`[图片] 已添加: ${imgPath} (${mimeType}, ${sizeKb}KB)`);

        if (textPrompt) {
          // 有文本提示：设置待发送消息，CLI 处理完斜杠命令后自动发送
          appState.set('pendingMessage', textPrompt);
          console.log(`[图片] 即将发送: ${textPrompt}`);
        } else {
          console.log(`[图片] 当前共 ${pending.length} 张待发送，输入文本后将自动附加`);
        }
      } catch (err) {
        console.log(`[图片] 读取失败: ${err}`);
      }
      return true;
    }

    case '/index': {
      await scanProject();
      return true;
    }

    case '/ask': {
      const question = args.join(' ');
      if (!question) {
        console.log('[问答] 用法: /ask <问题>');
        return true;
      }

      const index = loadIndex();
      if (!index) {
        console.log('[问答] 未找到索引，请先运行 /index');
        return true;
      }

      const results = searchIndex(question, index);
      if (results.length === 0) {
        console.log('[问答] 未找到相关文件');
        return true;
      }

      const topFiles = results.slice(0, 5);
      const context = topFiles.map(f =>
        `## ${f.path}\n导出: ${f.exports.slice(0, 10).join(', ')}\n函数: ${f.functions.slice(0, 10).join(', ')}`
      ).join('\n\n');

      console.log(`[问答] 基于 ${topFiles.length} 个文件回答...`);

      const response = await callLLM([
        { role: 'system', content: '你是一个代码助手，基于提供的项目文件信息回答问题。' },
        { role: 'user', content: `项目文件信息:\n${context}\n\n问题: ${question}` },
      ]);

      console.log(`\n💬 ${response.content}\n`);
      return true;
    }

    case '/exit':
    case '/quit':
      console.log('再见！');
      process.exit(0);

    case '/help':
      console.log(`
可用命令:
  /connect [api_key] [base_url] [model]  - 设置 API 配置（无参数启动交互向导）
  /model [模型名|list]                   - 查看/快速切换模型
  /provider [list|save|switch|remove]    - 管理多模型 Provider 配置
  /session [list|switch|new|rename|remove] - 管理多会话
  /compact                               - 手动压缩上下文
  /distill                               - 经验蒸馏，生成技能库
  /dream                                 - 记忆整理
  /skill [list|<name>|reload]            - 查看/刷新技能库
  /window [status|set <n>]               - 查看/设置滚动窗口
  /task [status|steps|reset]             - 查看/管理任务级 checkpoint
  /tools                                 - 查看所有可用工具
  /allow [命令名|remove <命令名>]         - 管理非白名单命令授权（执行时也可交互式授权）
  /image [图片路径|list|clear]            - 添加图片到下一次对话（多模态）
  /index                                 - 扫描项目并生成代码索引
  /ask <问题>                            - 基于索引回答代码库问题
  /exit                                  - 退出程序
  /help                                  - 显示帮助
`);
      return true;

    default:
      console.log(`未知命令: ${command}，输入 /help 查看帮助`);
      return true;
  }
}

// ==================== MCP 初始化（需访问全局 tools + runShell） ====================

/** 加载 MCP 外部工具并合并到 tools 列表 */
export function initMcpTools(
  tools: Tool[],
  shellExecutor: (cmd: string, timeout?: number) => Promise<string>,
): void {
  const mcpTools = loadMcpTools(shellExecutor);
  for (const t of mcpTools) {
    if (tools.some(existing => existing.name === t.name)) {
      console.warn(`[MCP] 工具名冲突，已忽略: ${t.name}`);
      continue;
    }
    tools.push(t);
  }
  if (mcpTools.length > 0) {
    console.log(`[MCP] 已加载 ${mcpTools.length} 个外部工具`);
  }
}

// ==================== 补全元数据 ====================

/** 斜杠命令清单（用于 Tab 补全 + 提示） */
export const SLASH_COMMANDS: Array<{ name: string; description: string; subArgs?: string[] }> = [
  { name: '/connect', description: '设置 API 配置（无参数启动交互向导）', subArgs: ['[api_key]', '[base_url]', '[model]'] },
  { name: '/model', description: '查看/快速切换模型', subArgs: ['<模型名>', 'list'] },
  { name: '/provider', description: '管理多模型 Provider 配置', subArgs: ['list', 'save', 'switch', 'remove'] },
  { name: '/compact', description: '手动压缩上下文' },
  { name: '/distill', description: '经验蒸馏，生成技能库' },
  { name: '/dream', description: '记忆整理' },
  { name: '/skill', description: '查看/刷新技能库', subArgs: ['list', '<name>', 'reload'] },
  { name: '/window', description: '查看/设置滚动窗口', subArgs: ['status', 'set'] },
  { name: '/task', description: '查看/管理任务级 checkpoint', subArgs: ['status', 'steps', 'reset'] },
  { name: '/session', description: '管理多会话', subArgs: ['list', 'switch', 'new', 'rename', 'remove'] },
  { name: '/tools', description: '查看所有可用工具' },
  { name: '/allow', description: '管理非白名单命令授权', subArgs: ['<命令名>', 'remove <命令名>'] },
  { name: '/image', description: '添加图片到下一次对话（多模态）', subArgs: ['<图片路径>', 'list', 'clear'] },
  { name: '/index', description: '扫描项目并生成代码索引' },
  { name: '/ask', description: '基于索引回答代码库问题', subArgs: ['<问题>'] },
  { name: '/exit', description: '退出程序' },
  { name: '/quit', description: '退出程序（别名）' },
  { name: '/help', description: '显示帮助' },
];

/** 工具清单（用于 /tools 补全） */
export function getToolList(ctx: SlashContext): Array<{ name: string; description: string; source?: string }> {
  return ctx.tools.map(t => ({ name: t.name, description: t.description, source: t.source }));
}
