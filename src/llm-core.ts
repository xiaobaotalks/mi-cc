/**
 * LLM 核心模块
 * 包含所有 LLM 调用相关函数：错误分类、超时、重试、System Prompt、上下文压缩
 */

import * as fs from 'fs';
import {
  tieredCompact,
  estimateTotalTokens,
  saveStateFromMessages,
  compactRollingWindow,
  checkRollingWindow,
} from '../compress';
import { matchSkill, formatSkillForPrompt } from '../skills';
import type { Message } from '../types';
import {
  toolsToOpenAIFormat,
} from '../tools';
import {
  readCheckpoint,
  readMemory,
  readNotes,
  appendNote,
  SKILL_LIB_FILE,
} from '../memory';
import { appState } from './state';
import OpenAI from 'openai';

// ==================== 常量 ====================

export const LLM_TIMEOUT_MS = 120_000;  // 2 分钟，代码生成等复杂任务需要较长时间
export const LLM_MAX_RETRIES = 3;

/**
 * API 调用时的最大输出 token 数（max_tokens 参数）
 * 注意：这与 config.maxTokens (上下文窗口) 不同
 * - config.maxTokens = 模型的上下文窗口大小（如 MiMo = 1M），用于压缩阈值计算
 * - MAX_OUTPUT_TOKENS = 单次回复的最大输出长度，传给 API 的 max_tokens 参数
 */
const MAX_OUTPUT_TOKENS = 4096;

// ==================== 错误分类 ====================

/** 分类 LLM 错误类型 */
export function classifyLLMError(error: unknown): 'auth' | 'rate_limit' | 'server' | 'context_length' | 'unknown' {
  const msg = (error as Error).message || String(error);
  if (/invalid.*api.*key|authentication|unauthorized|401/i.test(msg)) return 'auth';
  if (/rate.?limit|429|too.?many.?requests/i.test(msg)) return 'rate_limit';
  if (/context.?length|maximum.?context|too.?many.?tokens|prompt.*too.*long/i.test(msg)) return 'context_length';
  if (/500|502|503|504|econnrefused|econnreset|timeout|ETIMEDOUT/i.test(msg)) return 'server';
  return 'unknown';
}

// ==================== LLM 调用 ====================

/** 带超时的 LLM 调用（优先使用 ProviderRouter 故障转移） */
export async function callLLMWithTimeout(messages: Message[]): Promise<Message> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const tools = toolsToOpenAIFormat(appState.get('tools'));

    // 优先使用 ProviderRouter（支持多 Provider 故障转移）
    const router = appState.router;
    if (router) {
      const response = await router.chat({
        messages: messages as unknown as any[],
        tools,
        toolChoice: 'auto',
        maxTokens: MAX_OUTPUT_TOKENS,
        signal: controller.signal,
      });
      return response.message;
    }

    // 回退：直接使用 appState 中的 OpenAI 客户端
    const response = await appState.get('openai').chat.completions.create({
      model: appState.get('config').model,
      messages: messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      tool_choice: 'auto',
      max_tokens: MAX_OUTPUT_TOKENS,
    }, { signal: controller.signal as any });
    return response.choices[0].message as unknown as Message;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 处理上下文超限错误：压缩对话历史并更新状态 */
export async function handleContextLengthError(reducedMax: number): Promise<void> {
  const result = await tieredCompact(
    appState.get('openai'),
    appState.get('config').model,
    appState.get('conversationHistory'),
    reducedMax,
    (msg) => console.log(msg),
  );
  if (result.changed) {
    appState.set('conversationHistory', result.messages);
    saveStateFromMessages(appState.get('conversationHistory'), appState.get('currentSessionId'));
  }
  appendNote(`[LLM] 上下文超限，已将 maxTokens 降至 ${reducedMax}`);
}

/** 单次 LLM 调用 */
export async function callLLMSingle(messages: Message[]): Promise<Message> {
  return await callLLMWithTimeout(messages);
}

/** 处理上下文超限并重试 */
async function handleContextLengthAndRetry(messages: Message[]): Promise<Message> {
  console.log(`[LLM] 触发上下文超限，自动压缩历史...`);
  const contextWindow = appState.get('config').maxTokens;
  await handleContextLengthError(contextWindow);
  const retryMessages: Message[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...appState.get('conversationHistory'),
  ];
  return await callLLMSingle(retryMessages);
}

/** 指数退避重试 */
export async function retryWithBackoff(messages: Message[]): Promise<Message> {
  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    const delay = 500 * Math.pow(2, attempt);
    console.log(`[LLM] 调用失败，第 ${attempt + 1}/${LLM_MAX_RETRIES} 次重试，等待 ${delay}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      return await callLLMSingle(messages);
    } catch (retryError) {
      const retryCategory = classifyLLMError(retryError);

      if (retryCategory === 'auth' || retryCategory === 'rate_limit') {
        throw new Error(`[LLM] 重试过程中遇到${retryCategory === 'auth' ? '认证' : '限速'}错误，终止重试。原始错误: ${retryError}`);
      }

      if (retryCategory === 'context_length') {
        console.log(`[LLM] 重试时触发上下文超限，自动压缩历史...`);
        const contextWindow = appState.get('config').maxTokens;
        await handleContextLengthError(contextWindow);
        const retryMessages: Message[] = [
          { role: 'system', content: buildSystemPrompt() },
          ...appState.get('conversationHistory'),
        ];
        return await callLLMSingle(retryMessages);
      }

      if (attempt === LLM_MAX_RETRIES - 1) {
        throw new Error(`[LLM] 调用失败（已重试 ${LLM_MAX_RETRIES} 次）。原始错误: ${retryError}`);
      }
    }
  }
  throw new Error('[LLM] 调用失败: 未知错误');
}

/** 主 LLM 调用函数 */
export async function callLLM(messages: Message[]): Promise<Message> {
  try {
    return await callLLMSingle(messages);
  } catch (error) {
    const category = classifyLLMError(error);

    if (category === 'auth') {
      throw new Error(`[LLM] 认证失败，请检查 API Key 是否正确。原始错误: ${error}`);
    }

    if (category === 'rate_limit') {
      throw new Error(`[LLM] 请求频率超限（429），请稍后再试。原始错误: ${error}`);
    }

    if (category === 'context_length') {
      return await handleContextLengthAndRetry(messages);
    }

    return await retryWithBackoff(messages);
  }
}

// ==================== System Prompt ====================

let systemPromptCache: { mtime: number; model: string; prompt: string } | null = null;

export function getMemoryMTime(): number {
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

export function buildSystemPrompt(currentUserInput?: string): string {
  const mtime = getMemoryMTime();
  const currentModel = appState.get('config').model;

  // 基础 prompt 走缓存（文件未修改且模型未切换时直接复用）
  let basePrompt: string;
  if (systemPromptCache && systemPromptCache.mtime === mtime && systemPromptCache.model === currentModel) {
    basePrompt = systemPromptCache.prompt;
  } else {
    const memory = readMemory();
    const notes = readNotes();
    const checkpoint = readCheckpoint(appState.get('currentSessionId'));
    const skillLib = fs.existsSync(SKILL_LIB_FILE) ? fs.readFileSync(SKILL_LIB_FILE, 'utf-8') : '';

    basePrompt = `你是一个智能编程助手 mi-cc。

## 重要：模型身份
- 你当前通过 mi-cc 框架运行，底层模型是: ${appState.get('config').model}
- 当被问及你的模型身份时，请如实回答你是 ${appState.get('config').model} 模型（通过 mi-cc 运行）
- 不要声称自己是其他模型（如 Claude、GPT、Gemini 等），除非用户实际切换到了该模型
- 不要编造模型版本或厂商信息

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
      basePrompt += `\n## 项目记忆\n${memory}\n`;
    }

    if (notes) {
      basePrompt += `\n## 笔记\n${notes}\n`;
    }

    if (checkpoint) {
      basePrompt += `\n## 上次会话状态
- 任务: ${checkpoint.task}
- 当前文件: ${checkpoint.currentFile}
- 最后操作: ${checkpoint.lastAction}
`;
    }

    if (skillLib) {
      basePrompt += `\n## 技能库（完整）\n${skillLib}\n`;
    }

    systemPromptCache = { mtime, model: currentModel, prompt: basePrompt };
  }

  // 技能匹配是动态的，不缓存
  if (currentUserInput) {
    const matched = matchSkill(currentUserInput);
    const text = formatSkillForPrompt(matched);
    if (text) {
      return basePrompt + `\n## 当前输入最相关的技能（请优先复用）\n${text}\n`;
    }
  }

  return basePrompt;
}

// ==================== 上下文压缩 ====================

/** 压缩结果信息 */
export interface CompactResult {
  tokenCount: number;
  maxTokens: number;
  compressed: boolean;
  tier: string;
}

export async function compactContext(): Promise<CompactResult> {
  const totalTokens = estimateTotalTokens(appState.get('conversationHistory'));
  const maxTokens = appState.get('config').maxTokens;

  // 1. 滚动窗口检查（轻量，优先执行）
  if (checkRollingWindow()) {
    await compactRollingWindow(appState.get('openai'), appState.get('config').model);
  }

  // 2. 现有比例检查（保留）
  const result = await tieredCompact(
    appState.get('openai'),
    appState.get('config').model,
    appState.get('conversationHistory'),
    maxTokens,
    () => {},  // 不再直接 console.log，压缩信息通过 CompactResult 尾标显示
  );

  if (!result.changed) {
    return { tokenCount: totalTokens, maxTokens, compressed: false, tier: result.tier };
  }

  appState.set('conversationHistory', result.messages);
  saveStateFromMessages(appState.get('conversationHistory'), appState.get('currentSessionId'));
  const afterTokens = estimateTotalTokens(appState.get('conversationHistory'));
  appendNote(`上下文压缩完成（${result.tier}），剩余 token: ${afterTokens}`);
  return { tokenCount: afterTokens, maxTokens, compressed: true, tier: result.tier };
}
