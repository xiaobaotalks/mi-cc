/**
 * 斜杠命令处理：/connect /compact /distill /dream /skill /tools /help /exit
 * 所有命令通过 SlashContext 获取/修改运行时状态
 */

import * as fs from 'fs';
import OpenAI from 'openai';
import type { Message, Tool, HistoryRecord, Config } from './types';
import {
  tieredCompact,
  estimateTotalTokens,
  saveStateFromMessages,
} from './compress';
import { loadSkills, reloadSkills } from './skills';
import { loadMcpTools } from './mcp';
import {
  readCheckpoint,
  readMemory,
  queryHistory,
  saveHistoryToFile,
  MEMORY_FILE,
  SKILL_LIB_FILE,
} from './memory';

// ==================== 上下文接口 ====================

/** 斜杠命令共享的运行时上下文 */
export interface SlashContext {
  openai: OpenAI;
  config: Config;
  tools: Tool[];
  conversationHistory: Message[];
  historyData: HistoryRecord[];
  currentSessionId: string;
}

// ==================== /connect ====================

function handleConnect(ctx: SlashContext, args: string[]): void {
  if (args.length === 0) {
    console.log('用法: /connect <api_key> [base_url] [model]');
    console.log('当前配置:');
    console.log(`  API Key: ${ctx.config.apiKey ? '已设置' : '未设置'}`);
    console.log(`  Base URL: ${ctx.config.baseUrl}`);
    console.log(`  Model: ${ctx.config.model}`);
    return;
  }

  ctx.config.apiKey = args[0];
  if (args[1]) ctx.config.baseUrl = args[1];
  if (args[2]) ctx.config.model = args[2];

  ctx.openai = new OpenAI({
    apiKey: ctx.config.apiKey,
    baseURL: ctx.config.baseUrl,
  });

  const maxToken = ctx.config.maxTokens && !isNaN(ctx.config.maxTokens) ? ctx.config.maxTokens : 8000;
  const envContent = `API_KEY=${ctx.config.apiKey}
BASE_URL=${ctx.config.baseUrl}
MODEL=${ctx.config.model}
MAX_TOKEN=${maxToken}
`;
  fs.writeFileSync('.env', envContent, 'utf-8');
  console.log('配置已更新并保存');
}

// ==================== /compact ====================

async function handleCompact(ctx: SlashContext): Promise<void> {
  console.log('[手动压缩] 开始...');
  const beforeTokens = estimateTotalTokens(ctx.conversationHistory);

  const forcedMax = Math.max(Math.ceil(beforeTokens * 1.5), ctx.config.maxTokens);
  const result = await tieredCompact(
    ctx.openai,
    ctx.config.model,
    ctx.conversationHistory,
    forcedMax,
    (msg) => console.log(msg),
  );

  if (result.changed) {
    ctx.conversationHistory.splice(0, ctx.conversationHistory.length, ...result.messages);
    saveStateFromMessages(ctx.conversationHistory);
    const afterTokens = estimateTotalTokens(ctx.conversationHistory);
    console.log(`[手动压缩] 完成 (${result.tier}): ${beforeTokens} -> ${afterTokens} tokens`);
  } else {
    console.log('[手动压缩] 没有可压缩的历史');
  }
}

// ==================== /distill ====================

async function handleDistill(ctx: SlashContext): Promise<void> {
  console.log('[蒸馏] 开始经验蒸馏...');

  const checkpoint = readCheckpoint();
  const memory = readMemory();
  const history = queryHistory(ctx.historyData, ctx.currentSessionId);

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
    const beforeCount = ctx.historyData.length;
    ctx.historyData = ctx.historyData.filter(r => r.time >= sevenDaysAgo);
    saveHistoryToFile(ctx.historyData);
    console.log(`[Dream] 过期日志已清理: ${beforeCount} -> ${ctx.historyData.length}`);
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

// ==================== /tools ====================

function handleToolsCommand(ctx: SlashContext): void {
  console.log(`[Tools] 共 ${ctx.tools.length} 个工具：`);
  for (const t of ctx.tools) {
    const tag = t.source === 'mcp' ? ' (MCP)' : '';
    console.log(`  - ${t.name}${tag}: ${t.description}`);
  }
}

// ==================== 路由 ====================

/** 处理所有斜杠命令，返回 true 表示已处理 */
export async function handleSlashCommand(ctx: SlashContext, input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  switch (command) {
    case '/connect':
      handleConnect(ctx, args);
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

    case '/tools':
      handleToolsCommand(ctx);
      return true;

    case '/exit':
    case '/quit':
      console.log('再见！');
      process.exit(0);

    case '/help':
      console.log(`
可用命令:
  /connect <api_key> [base_url] [model]  - 设置 API 配置
  /compact                               - 手动压缩上下文
  /distill                               - 经验蒸馏，生成技能库
  /dream                                 - 记忆整理
  /skill [list|<name>|reload]            - 查看/刷新技能库
  /tools                                 - 查看所有可用工具
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
  { name: '/connect', description: '设置 API 配置', subArgs: ['<api_key>', '[base_url]', '[model]'] },
  { name: '/compact', description: '手动压缩上下文' },
  { name: '/distill', description: '经验蒸馏，生成技能库' },
  { name: '/dream', description: '记忆整理' },
  { name: '/skill', description: '查看/刷新技能库', subArgs: ['list', '<name>', 'reload'] },
  { name: '/tools', description: '查看所有可用工具' },
  { name: '/exit', description: '退出程序' },
  { name: '/quit', description: '退出程序（别名）' },
  { name: '/help', description: '显示帮助' },
];

/** 工具清单（用于 /tools 补全） */
export function getToolList(ctx: SlashContext): Array<{ name: string; description: string; source?: string }> {
  return ctx.tools.map(t => ({ name: t.name, description: t.description, source: t.source }));
}
