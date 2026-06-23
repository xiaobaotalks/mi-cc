/**
 * Agent - LLM Agent 循环与工具调用
 * 包含 runAgent、handleToolCalls 及相关工具函数
 * LLM 核心函数已移至 llm-core.ts
 */

import {
  toolsToOpenAIFormat,
  executeToolCall,
  extractFileFromArgs,
} from '../tools';
import {
  writeCheckpoint,
  saveHistory,
  readTaskCheckpoint,
  writeTaskCheckpoint,
  createTaskCheckpoint,
  addTaskStep,
  updateTaskStep,
  addModifiedFile,
} from '../memory';
import { appState } from './state';
import OpenAI from 'openai';
import type { Message } from '../types';

import { callLLM, buildSystemPrompt, compactContext } from './llm-core';
import type { CompactResult } from './llm-core';
import { contentToString } from '../compress';
import {
  renderToolResult,
  renderAssistant,
  renderWarning,
  renderContextBar,
} from './ui';
import chalk from 'chalk';

// ==================== 常量 ====================

const MAX_TOOL_ITERATIONS = 20;

// ==================== 工具函数 ====================

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

// ==================== 工具调用处理 ====================

export async function handleToolCalls(message: OpenAI.Chat.Completions.ChatCompletionMessage): Promise<string[]> {
  if (!message.tool_calls || message.tool_calls.length === 0) {
    return [];
  }

  const results: string[] = [];
  let lastFile = ''; // 需要从 checkpoint 读取，延迟导入避免循环依赖
  const { readCheckpoint } = await import('../memory');
  const checkpoint = readCheckpoint(appState.get('currentSessionId'));
  if (checkpoint) {
    lastFile = checkpoint.currentFile || '';
  }
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

    const t0 = Date.now();
    const result = await executeToolCall(appState.get('tools'), toolName, args);
    const elapsed = Date.now() - t0;
    results.push(result);

    renderToolResult(toolName, args, previewResult(result), elapsed);

    const file = extractFileFromArgs(toolName, args);
    if (file) lastFile = file;

    writeCheckpoint({
      sessionId: appState.get('currentSessionId'),
      task: contentToString(appState.get('conversationHistory').find(m => m.role === 'user')?.content || '').substring(0, 100) || '',
      currentFile: lastFile,
      lastAction: toolName,
      result: result.substring(0, 200),
      stage: '执行中',
      time: new Date().toISOString(),
    }, appState.get('currentSessionId'));
  }

  return results;
}

// ==================== Agent 主循环 ====================

export async function runAgent(userInput: string): Promise<void> {
  // 读取或创建任务级 checkpoint
  let taskCheckpoint = readTaskCheckpoint(appState.get('currentSessionId'));
  if (!taskCheckpoint || taskCheckpoint.sessionId !== appState.get('currentSessionId')) {
    taskCheckpoint = createTaskCheckpoint(appState.get('currentSessionId'), userInput);
  }

  // 添加用户输入作为新步骤
  const step = addTaskStep(taskCheckpoint, `用户输入: ${userInput}`);
  updateTaskStep(taskCheckpoint, step.id, { status: 'in_progress' });
  writeTaskCheckpoint(taskCheckpoint, appState.get('currentSessionId'));

  appState.get('conversationHistory').push({ role: 'user', content: userInput });
  appState.set('historyData', saveHistory(appState.get('historyData'), appState.get('currentSessionId'), 'user', userInput));

  // 如果有待发送的图片，将用户消息改为多模态格式
  const pendingImages = appState.get('pendingImages');
  if (pendingImages.length > 0) {
    const contentParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: userInput },
    ];
    for (const img of pendingImages) {
      contentParts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }
    // 替换最后一条用户消息为多模态格式
    const lastMsg = appState.get('conversationHistory')[appState.get('conversationHistory').length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = contentParts;
    }
    console.log(chalk.gray(`📎 已附加 ${pendingImages.length} 张图片到本次对话`));
    // 清空待发送图片
    appState.set('pendingImages', []);
  }

  const compactResult = await compactContext();

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(userInput) },
    ...appState.get('conversationHistory'),
  ];

  process.stdout.write(chalk.gray('🤔 思考中...\n'));
  let response = await callLLM(messages);

  let iterations = 0;
  while (true) {
    appState.get('conversationHistory').push(response);
    const responseContentStr = contentToString(response.content);
    appState.set('historyData', saveHistory(appState.get('historyData'), appState.get('currentSessionId'), 'assistant', responseContentStr || JSON.stringify(response)));

    if (responseContentStr) {
      renderAssistant(responseContentStr, compactResult);
    }

    const toolCalls = (response as OpenAI.Chat.Completions.ChatCompletionMessage).tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      break;
    }

    iterations++;
    if (iterations > MAX_TOOL_ITERATIONS) {
      renderWarning(`已达到最大工具调用轮数 (${MAX_TOOL_ITERATIONS})，强制停止`);
      break;
    }

    // 为每个 tool call 创建步骤
    for (const tc of toolCalls) {
      const toolStep = addTaskStep(taskCheckpoint, `工具调用: ${tc.function.name}`);
      updateTaskStep(taskCheckpoint, toolStep.id, { status: 'in_progress' });
    }
    writeTaskCheckpoint(taskCheckpoint, appState.get('currentSessionId'));

    // 显示正在调用的工具
    for (const tc of toolCalls) {
      let argsPreview = '';
      try {
        const a = JSON.parse(tc.function.arguments);
        argsPreview = a.path || a.command || a.query || a.pattern || '';
        if (argsPreview) argsPreview = ` ${chalk.gray(argsPreview)}`;
      } catch {}
      process.stdout.write(chalk.cyan(`🔧 调用工具: ${tc.function.name}${argsPreview}\n`));
    }

    const results = await handleToolCalls(response as OpenAI.Chat.Completions.ChatCompletionMessage);

    // 更新步骤状态
    for (let i = 0; i < toolCalls.length; i++) {
      const toolStep = taskCheckpoint.steps[taskCheckpoint.steps.length - toolCalls.length + i];
      updateTaskStep(taskCheckpoint, toolStep.id, {
        status: 'done',
        result: results[i].substring(0, 200),
      });

      // 检测文件修改
      if (toolCalls[i].function.name === 'writeFile') {
        const args = JSON.parse(toolCalls[i].function.arguments);
        addModifiedFile(taskCheckpoint, args.path);
      }
    }
    writeTaskCheckpoint(taskCheckpoint, appState.get('currentSessionId'));

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
    process.stdout.write(chalk.gray('🤔 继续思考...\n'));
    response = await callLLM(nextMessages);
  }

  // 完成时更新 checkpoint
  updateTaskStep(taskCheckpoint, step.id, { status: 'done' });
  writeTaskCheckpoint(taskCheckpoint, appState.get('currentSessionId'));

  // 同时写入旧的 checkpoint（兼容）
  writeCheckpoint({
    sessionId: appState.get('currentSessionId'),
    task: userInput.substring(0, 100),
    currentFile: '',
    lastAction: '对话',
    result: contentToString(response.content).substring(0, 200) || '',
    stage: '完成',
    time: new Date().toISOString(),
  }, appState.get('currentSessionId'));
}
