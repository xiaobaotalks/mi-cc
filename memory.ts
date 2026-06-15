/**
 * 四层记忆系统：checkpoint / MEMORY / notes / history
 * 纯函数模块，不持有可变状态（historyData 由调用方传入传出）
 */

import * as fs from 'fs';
import type { Checkpoint, HistoryRecord } from './types';

// ==================== 文件路径常量 ====================

export const CHECKPOINT_FILE = 'checkpoint.md';
export const MEMORY_FILE = 'MEMORY.md';
export const NOTES_FILE = 'notes.md';
export const SKILL_LIB_FILE = 'skill-lib.md';
export const HISTORY_FILE = 'history.json';

// ==================== 历史记录容量 ====================

export const HISTORY_MAX_RECORDS = 5000;
export const HISTORY_KEEP_RECORDS = 4000;

// ==================== L1 会话记忆 ====================

export function readCheckpoint(): Checkpoint | null {
  try {
    if (!fs.existsSync(CHECKPOINT_FILE)) return null;
    const content = fs.readFileSync(CHECKPOINT_FILE, 'utf-8');
    const lines = content.split('\n');
    const checkpoint: Record<string, string> = {};

    for (const line of lines) {
      const match = line.match(/^##\s*(\w+):\s*(.+)$/);
      if (match) {
        checkpoint[match[1]] = match[2];
      }
    }

    return {
      sessionId: checkpoint.sessionId || '',
      task: checkpoint.task || '',
      currentFile: checkpoint.currentFile || '',
      lastAction: checkpoint.lastAction || '',
      result: checkpoint.result || '',
      stage: checkpoint.stage || '',
      time: checkpoint.time || '',
    };
  } catch {
    return null;
  }
}

export function writeCheckpoint(checkpoint: Checkpoint): void {
  const content = `# 会话检查点

## sessionId: ${checkpoint.sessionId}
## task: ${checkpoint.task}
## currentFile: ${checkpoint.currentFile}
## lastAction: ${checkpoint.lastAction}
## result: ${checkpoint.result}
## stage: ${checkpoint.stage}
## time: ${checkpoint.time}
`;
  fs.writeFileSync(CHECKPOINT_FILE, content, 'utf-8');
}

// ==================== L2 项目记忆 ====================

export function readMemory(): string {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      const defaultContent = `# 项目记忆

## 架构决策
- 待记录

## 关键 Bug
- 待记录

## 目录规范
- 待记录

## 技术栈
- Node.js + TypeScript
`;
      fs.writeFileSync(MEMORY_FILE, defaultContent, 'utf-8');
      return defaultContent;
    }
    return fs.readFileSync(MEMORY_FILE, 'utf-8');
  } catch {
    return '';
  }
}

export function appendMemory(section: string, content: string): void {
  let memory = readMemory();
  const timestamp = new Date().toISOString();
  const entry = `\n### [${timestamp}]\n${content}\n`;

  const sectionRegex = new RegExp(`(## ${section}[\\s\\S]*?)(?=## |$)`);
  if (sectionRegex.test(memory)) {
    memory = memory.replace(sectionRegex, `$1${entry}`);
  } else {
    memory += `\n## ${section}\n${entry}`;
  }

  fs.writeFileSync(MEMORY_FILE, memory, 'utf-8');
}

// ==================== L3 笔记暂存 ====================

export function readNotes(): string {
  try {
    if (!fs.existsSync(NOTES_FILE)) return '';
    return fs.readFileSync(NOTES_FILE, 'utf-8');
  } catch {
    return '';
  }
}

export function appendNote(note: string): void {
  const timestamp = new Date().toISOString();
  const content = `\n## [${timestamp}]\n${note}\n`;
  fs.appendFileSync(NOTES_FILE, content, 'utf-8');
}

// ==================== L4 历史日志 ====================

/** 从文件加载历史数据 */
export function initHistory(): HistoryRecord[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // ignore
  }
  return [];
}

/** 保存历史数据到文件 */
export function saveHistoryToFile(data: HistoryRecord[]): void {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.log(`[警告] 保存历史失败: ${error}`);
  }
}

/** 生成唯一 ID：时间戳 ×10000 + 随机序号（100-999），保证单调递增 */
export function generateRecordId(data: HistoryRecord[]): number {
  const ts = Date.now();
  const rand = 100 + Math.floor(Math.random() * 900); // 3位数，避免与 maxId+1 冲突
  const maxId = data.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
  // 时间戳部分足够大（×10000），确保新ID永远比旧的更大
  const candidate = ts * 10000 + rand;
  return Math.max(maxId + 1, candidate);
}

/** 当历史超过上限时丢弃较早记录，返回裁剪后的数组 */
export function rotateHistory(data: HistoryRecord[]): HistoryRecord[] {
  if (data.length <= HISTORY_MAX_RECORDS) return data;
  const dropped = data.length - HISTORY_KEEP_RECORDS;
  const trimmed = data.slice(dropped);
  saveHistoryToFile(trimmed);
  appendNote(`[自动轮转] 历史日志已达上限，丢弃较早 ${dropped} 条`);
  return trimmed;
}

/** 添加一条历史记录，返回新的数组（含轮转） */
export function saveHistory(
  data: HistoryRecord[],
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): HistoryRecord[] {
  const time = new Date().toISOString();
  const record: HistoryRecord = {
    id: generateRecordId(data),
    sessionId,
    role,
    content,
    time,
  };
  data.push(record);
  return rotateHistory(data);
}

/** 查询历史（可选按 sessionId / 关键词过滤），最多返回 100 条 */
export function queryHistory(
  data: HistoryRecord[],
  sessionId?: string,
  keyword?: string,
): HistoryRecord[] {
  let results = [...data];

  if (sessionId) {
    results = results.filter(r => r.sessionId === sessionId);
  }
  if (keyword) {
    results = results.filter(r => r.content.includes(keyword));
  }

  return results
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 100);
}

// ==================== 工具函数 ====================

export function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
