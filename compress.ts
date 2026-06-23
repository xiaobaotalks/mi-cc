/**
 * 上下文压缩模块
 *
 * 设计要点：
 * 1. 分层摘要（Hierarchical Summary）：保留多层历史摘要，避免一次性把所有早期内容压成一段导致细节丢失
 * 2. 增量压缩（Incremental Compression）：只在超出档位时才压缩最老的一层，并对最老的"已摘要"内容做合并重摘要
 * 3. 多档位触发（Tiered Trigger）：根据当前占用比例采取不同策略
 *    - 软阈值 60%：日志告警，不动作
 *    - 标准阈值 80%：把最早的原始消息摘要化为 1 层摘要，保留最近 N 轮原文
 *    - 紧急阈值 95%：把已有摘要与更早原文合并重摘要为更高一层，保留最近 M 轮原文 (M < N)
 * 4. 更准的 token 估算：CJK 字符 1.6 token/字，ASCII 字符 0.3 token/字，单条消息加 4 token overhead
 */

import * as fs from 'fs';
import OpenAI from 'openai';
import type { Message } from './types';
import { appState } from './src/state';
import { getCompressStateFile } from './memory';
import { callLLM } from './src/llm-core';

export const COMPRESS_TIERS = {
  SOFT: 0.6,
  STANDARD: 0.8,
  URGENT: 0.95,
} as const;

/** 已知模型的上下文窗口大小（tokens） */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // 小米 MiMo 系列（1M 上下文）
  'mimo-v2.5-pro': 1_048_576,
  'mimo-v2.5': 1_048_576,
  'mimo-v2-pro': 1_048_576,
  'mimo-v2-flash': 1_048_576,
  'mimo-v2-omni': 262_144,
  'xiaomi-mimo': 1_048_576,
  // OpenAI 系列
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-3.5-turbo': 16_385,
  'gpt-5': 256_000,
  // Anthropic Claude
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-4-opus': 200_000,
  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  'deepseek-v4': 128_000,
  // 智谱 GLM
  'glm-4-plus': 128_000,
  'glm-4-flash': 128_000,
  'glm-5': 128_000,
  // 月之暗面 Moonshot
  'moonshot-v1-128k': 131_072,
  'moonshot-v1-32k': 32_768,
  // Kimi
  'kimi-k2': 131_072,
};

/** 根据模型名推断上下文窗口大小，未知模型返回 null */
export function resolveContextWindow(model: string): number | null {
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  const m = model.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (m.includes(key.toLowerCase()) || key.toLowerCase().includes(m)) return val;
  }
  return null;
}

export const RECENT_TURNS_STANDARD = 5;
export const RECENT_TURNS_URGENT = 3;

/** 摘要层（最新一层在最前面） */
export interface SummaryLayer {
  level: number;       // 0 = 最近一次的摘要，数字越大越旧
  text: string;        // 摘要内容
  createdAt: string;
  coversFrom: string;  // 这层摘要覆盖的对话起始时间
  coversTo: string;    // 这层摘要覆盖的对话结束时间
}

/** 压缩状态 */
export interface CompressState {
  summaries: SummaryLayer[];
}

/** 判断 LLM 错误是否为上下文超限 */
export function isContextLengthError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error as Error).message || String(error);
  return /context.length|maximum.context|context.window|too.many.tokens|reduce.the.length/i.test(msg)
    || /prompt.is.too.long/i.test(msg);
}

/** 上下文超限后建议的目标 token 数（保留 10% 余量） */
export function suggestMaxTokensAfterOverflow(contextWindow: number): number {
  return Math.floor(contextWindow * 0.9);
}

/** 加载压缩状态 */
export function loadCompressState(sessionId?: string): CompressState {
  const file = getCompressStateFile(sessionId);
  try {
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn(`[compress] 加载压缩状态失败: ${(e as Error).message}`);
  }
  return { summaries: [] };
}

/** 保存压缩状态 */
export function saveCompressState(state: CompressState, sessionId?: string): void {
  const file = getCompressStateFile(sessionId);
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`[compress] 保存压缩状态失败: ${(e as Error).message}`);
  }
}

/** 从消息列表中提取摘要层并持久化 */
export function saveStateFromMessages(messages: Message[], sessionId?: string): void {
  const { headSummaries } = splitMessages(messages);
  const layers = headSummaries
    .map(parseSummaryLayer)
    .filter((s): s is SummaryLayer => !!s);
  saveCompressState({ summaries: layers }, sessionId);
}

/** 将 MessageContent 安全转为字符串（多模态数组只取文本部分） */
export function contentToString(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (p.type === 'text' ? p.text : '[图片]'))
      .join('');
  }
  return '';
}

/** 更准确的 token 估算 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk * 1.6 + ascii * 0.3);
}

export function estimateMessageTokens(msg: Message): number {
  // content 可能是字符串或多模态数组，统一转为字符串估算
  const contentStr = contentToString(msg.content);
  let tokens = estimateTokens(contentStr || '') + 4; // 4 token 开销（role + 结构）
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments) + 8;
    }
  }
  if (msg.tool_call_id) {
    tokens += estimateTokens(msg.tool_call_id) + 4;
  }
  return tokens;
}

export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** 判断消息是否为摘要层 */
export function isSummaryMessage(msg: Message): boolean {
  return msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[历史摘要 L');
}

/** 从 system 消息中解析摘要层 */
export function parseSummaryLayer(msg: Message): SummaryLayer | null {
  if (typeof msg.content !== 'string') return null;
  const m = msg.content.match(/^\[历史摘要 L(\d+) @ ([^\]]+)\]\n([\s\S]*)$/);
  if (!m) return null;
  return {
    level: parseInt(m[1], 10),
    text: m[3],
    createdAt: m[2],
    coversFrom: '',
    coversTo: '',
  };
}

/** 调用 LLM 生成结构化摘要 */
export async function generateSummary(
  openai: OpenAI,
  model: string,
  blocks: Array<{ kind: 'raw' | 'summary'; content: string; meta?: string }>,
): Promise<string> {
  const prompt = `请将以下对话片段压缩为结构化摘要，必须保留关键事实，使用如下格式：

## 目标
- ...

## 关键命令
- ...

## 涉及文件
- ...

## 重要决策
- ...

## 未解决问题
- ...

## 输入内容
${blocks.map(b => {
  if (b.kind === 'summary') return `[旧摘要]\n${b.content}`;
  return `[对话]\n${b.content}`;
}).join('\n\n')}

请输出结构化摘要（Markdown）：`;

  try {
    const response = await callLLM([{ role: 'user', content: prompt }]);
    return response.content?.trim() || '摘要生成失败';
  } catch (error) {
    return `摘要生成错误: ${(error as Error).message}`;
  }
}

/** 在 history 头部分离摘要层与原始消息 */
export function splitMessages(messages: Message[]): { headSummaries: Message[]; rawMessages: Message[] } {
  const headSummaries: Message[] = [];
  let i = 0;
  while (i < messages.length && isSummaryMessage(messages[i])) {
    headSummaries.push(messages[i]);
    i++;
  }
  return { headSummaries, rawMessages: messages.slice(i) };
}

/** 把摘要层展开为文本块，供合并摘要使用 */
export function summarizeHead(headSummaries: Message[]): Array<{ kind: 'summary'; content: string }> {
  return headSummaries
    .map(parseSummaryLayer)
    .filter((s): s is SummaryLayer => !!s)
    .map(s => ({ kind: 'summary' as const, content: `L${s.level}: ${s.text}` }));
}

/**
 * 检查是否需要触发滚动窗口压缩
 * 当原始消息超过 maxRawTurns * 2（用户+助手各一轮=2条消息）时触发
 */
export function checkRollingWindow(): boolean {
  const rawMessages = appState.getRawMessages();
  const maxRaw = appState.maxRawTurns * 2; // 每轮包含 user + assistant
  return rawMessages.length > maxRaw;
}

/**
 * 执行滚动窗口压缩：将超窗的原始消息压缩为摘要
 */
export async function compactRollingWindow(openai: OpenAI, model: string): Promise<void> {
  if (!checkRollingWindow()) return;

  const rawMessages = appState.getRawMessages();
  const maxRaw = appState.maxRawTurns * 2;
  const excessCount = rawMessages.length - maxRaw;

  // 取超出的消息进行压缩
  const messagesToCompress = rawMessages.slice(0, excessCount);
  const remainingRaw = rawMessages.slice(excessCount);

  console.log(`[滚动窗口] 原始消息 ${rawMessages.length} 条，超出 ${excessCount} 条，触发压缩...`);

  // 构建压缩提示
  const compressPrompt: Message = {
    role: 'system',
    content: `请将以下对话历史压缩为简洁的摘要，保留关键信息和决策：

${messagesToCompress.map(m => `${m.role}: ${contentToString(m.content)}`).join('\n')}`,
  };

  const response = await callLLM([compressPrompt]);

  const summaryText = response.content || '';

  // 计算新摘要的 level
  const existingSummaries = appState.getSummaryMessages();
  const newLevel = existingSummaries.length > 0
    ? Math.max(...existingSummaries.map(parseSummaryLayer).map(s => s?.level ?? -1)) + 1
    : 0;

  const summaryMessage: Message = {
    role: 'system',
    content: `[历史摘要 L${newLevel} @ ${new Date().toISOString()}]\n${summaryText}`,
  };

  // 更新 conversationHistory：保留摘要层 + 保留的原始消息
  const newHistory = [
    ...existingSummaries,
    summaryMessage,
    ...remainingRaw,
  ];

  appState.set('conversationHistory', newHistory);

  // 持久化
  saveStateFromMessages(newHistory, appState.get('currentSessionId'));

  console.log(`[滚动窗口] 已压缩 ${excessCount} 条消息为 L${newLevel} 摘要`);
}

/**
 * 多档位压缩：根据当前 token 占用比例决定压缩档位
 * 返回是否执行了压缩及新的消息数组
 */
export async function tieredCompact(
  openai: OpenAI,
  model: string,
  messages: Message[],
  maxTokens: number,
  onNote?: (msg: string) => void,
): Promise<{ changed: boolean; messages: Message[]; tier: 'none' | 'standard' | 'urgent' }> {
  const total = estimateTotalTokens(messages);
  const ratio = total / maxTokens;
  const note = onNote || (() => {});

  if (ratio < COMPRESS_TIERS.STANDARD) {
    if (ratio >= COMPRESS_TIERS.SOFT) {
      note(`[压缩] 软阈值告警: ${(ratio * 100).toFixed(1)}% (${total}/${maxTokens})`);
    }
    return { changed: false, messages, tier: 'none' };
  }

  const { headSummaries, rawMessages } = splitMessages(messages);

  if (ratio >= COMPRESS_TIERS.URGENT) {
    // 紧急档：合并最老摘要层 + 最早原始消息 → 新一层摘要
    const keepRecent = RECENT_TURNS_URGENT * 2;
    if (rawMessages.length <= keepRecent) {
      note('[压缩] 紧急档：剩余原文不足，跳过');
      return { changed: false, messages, tier: 'urgent' };
    }
    const toCompressRaw = rawMessages.slice(0, rawMessages.length - keepRecent);
    const keepRaw = rawMessages.slice(-keepRecent);

    const blocks = [...summarizeHead(headSummaries), ...toCompressRaw.map(m => ({
      kind: 'raw' as const,
      content: `[${m.role}]: ${contentToString(m.content)}`,
    }))];

    note(`[压缩] 紧急档触发: ${(ratio * 100).toFixed(1)}%，合并 ${headSummaries.length} 层摘要 + ${toCompressRaw.length} 条原文`);
    const text = await generateSummary(openai, model, blocks);
    const newLevel = headSummaries.length > 0
      ? Math.max(...headSummaries.map(parseSummaryLayer).map(s => s?.level ?? -1)) + 1
      : 0;
    const summaryMsg: Message = {
      role: 'system',
      content: `[历史摘要 L${newLevel} @ ${new Date().toISOString()}]\n${text}`,
    };
    return {
      changed: true,
      messages: [summaryMsg, ...keepRaw],
      tier: 'urgent',
    };
  }

  // 标准档：把最早一批原始消息摘要化为新的最低层
  const keepRecent = RECENT_TURNS_STANDARD * 2;
  if (rawMessages.length <= keepRecent) {
    note('[压缩] 标准档：剩余原文不足，跳过');
    return { changed: false, messages, tier: 'standard' };
  }
  const toCompressRaw = rawMessages.slice(0, rawMessages.length - keepRecent);
  const keepRaw = rawMessages.slice(-keepRecent);

  note(`[压缩] 标准档触发: ${(ratio * 100).toFixed(1)}%，摘要 ${toCompressRaw.length} 条原文`);
  const blocks = toCompressRaw.map(m => ({
    kind: 'raw' as const,
    content: `[${m.role}]: ${contentToString(m.content)}`,
  }));
  const text = await generateSummary(openai, model, blocks);
  const newLevel = headSummaries.length > 0
    ? Math.max(...headSummaries.map(parseSummaryLayer).map(s => s?.level ?? -1)) + 1
    : 0;
  const summaryMsg: Message = {
    role: 'system',
    content: `[历史摘要 L${newLevel} @ ${new Date().toISOString()}]\n${text}`,
  };
  return {
    changed: true,
    messages: [summaryMsg, ...headSummaries, ...keepRaw],
    tier: 'standard',
  };
}
