/**
 * 四层记忆系统：checkpoint / MEMORY / notes / history
 * 纯函数模块，不持有可变状态（historyData 由调用方传入传出）
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Checkpoint, HistoryRecord, TaskCheckpoint, TaskStep } from './types';

// ==================== 文件路径常量 ====================

export const CHECKPOINT_FILE = 'checkpoint.md';
export const MEMORY_FILE = 'MEMORY.md';
export const NOTES_FILE = 'notes.md';
export const SKILL_LIB_FILE = 'skill-lib.md';
export const HISTORY_FILE = 'history.json';
export const TASK_CHECKPOINT_FILE = 'task-checkpoint.json';

// ==================== 会话目录管理 ====================

const SESSIONS_DIR = 'sessions';
const SESSION_INDEX = 'sessions/index.json';

export interface SessionEntry {
  id: string;
  task: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

export function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

export function getSessionDir(sessionId: string): string {
  ensureSessionsDir();
  return path.join(SESSIONS_DIR, sessionId);
}

export function ensureSessionDir(sessionId: string): void {
  const dir = getSessionDir(sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getSessionFile(sessionId: string, filename: string): string {
  return path.join(getSessionDir(sessionId), filename);
}

export function loadSessionIndex(): SessionEntry[] {
  try {
    if (fs.existsSync(SESSION_INDEX)) {
      return JSON.parse(fs.readFileSync(SESSION_INDEX, 'utf-8'));
    }
  } catch (e) {
    console.warn(`[memory] 加载会话索引失败: ${(e as Error).message}`);
  }
  return [];
}

export function saveSessionIndex(index: SessionEntry[]): void {
  ensureSessionsDir();
  fs.writeFileSync(SESSION_INDEX, JSON.stringify(index, null, 2), 'utf-8');
}

export function addOrUpdateSession(sessionId: string, task: string, messageCount: number): void {
  const index = loadSessionIndex();
  const now = new Date().toISOString();
  const existing = index.find(s => s.id === sessionId);
  if (existing) {
    existing.task = task;
    existing.lastActiveAt = now;
    existing.messageCount = messageCount;
  } else {
    index.push({
      id: sessionId,
      task,
      createdAt: now,
      lastActiveAt: now,
      messageCount,
    });
  }
  saveSessionIndex(index);
}

export function removeSession(sessionId: string): boolean {
  const index = loadSessionIndex();
  const idx = index.findIndex(s => s.id === sessionId);
  if (idx === -1) return false;
  index.splice(idx, 1);
  saveSessionIndex(index);

  // 删除会话目录
  const dir = getSessionDir(sessionId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
  return true;
}

// ==================== 会话感知文件路径 ====================

export function getCheckpointFile(sessionId?: string): string {
  if (sessionId) {
    ensureSessionDir(sessionId);
    return getSessionFile(sessionId, 'checkpoint.md');
  }
  return CHECKPOINT_FILE;
}

export function getHistoryFile(sessionId?: string): string {
  if (sessionId) {
    ensureSessionDir(sessionId);
    return getSessionFile(sessionId, 'history.json');
  }
  return HISTORY_FILE;
}

export function getCompressStateFile(sessionId?: string): string {
  if (sessionId) {
    ensureSessionDir(sessionId);
    return getSessionFile(sessionId, 'compress-state.json');
  }
  return 'compress-state.json';
}

export function getTaskCheckpointFile(sessionId?: string): string {
  if (sessionId) {
    ensureSessionDir(sessionId);
    return getSessionFile(sessionId, 'task-checkpoint.json');
  }
  return TASK_CHECKPOINT_FILE;
}

// ==================== 历史记录容量 ====================

export const HISTORY_MAX_RECORDS = 5000;
export const HISTORY_KEEP_RECORDS = 4000;

// ==================== L1 会话记忆 ====================

export function readCheckpoint(sessionId?: string): Checkpoint | null {
  const file = getCheckpointFile(sessionId);
  try {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf-8');
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
  } catch (e) {
    console.warn(`[memory] 读取 checkpoint 失败: ${(e as Error).message}`);
    return null;
  }
}

export function writeCheckpoint(checkpoint: Checkpoint, sessionId?: string): void {
  const file = getCheckpointFile(sessionId);
  const content = `# 会话检查点

## sessionId: ${checkpoint.sessionId}
## task: ${checkpoint.task}
## currentFile: ${checkpoint.currentFile}
## lastAction: ${checkpoint.lastAction}
## result: ${checkpoint.result}
## stage: ${checkpoint.stage}
## time: ${checkpoint.time}
`;
  fs.writeFileSync(file, content, 'utf-8');
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
  } catch (e) {
    console.warn(`[memory] 读取项目记忆失败: ${(e as Error).message}`);
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
  } catch (e) {
    console.warn(`[memory] 读取笔记失败: ${(e as Error).message}`);
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
export function initHistory(sessionId?: string): HistoryRecord[] {
  const file = getHistoryFile(sessionId);
  try {
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn(`[memory] 加载历史记录失败: ${(e as Error).message}`);
  }
  return [];
}

/** 保存历史数据到文件 */
export function saveHistoryToFile(data: HistoryRecord[], sessionId?: string): void {
  const file = getHistoryFile(sessionId);
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.log(`[警告] 保存历史失败: ${error}`);
  }
}

/** 生成唯一 ID：时间戳 ×1000 + 随机，保证单调递增 */
export function generateRecordId(data: HistoryRecord[]): number {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000);
  const maxId = data.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
  return Math.max(maxId + 1, ts * 1000 + rand);
}

/** 当历史超过上限时丢弃较早记录，返回裁剪后的数组 */
export function rotateHistory(data: HistoryRecord[], sessionId?: string): HistoryRecord[] {
  if (data.length <= HISTORY_MAX_RECORDS) return data;
  const dropped = data.length - HISTORY_KEEP_RECORDS;
  const trimmed = data.slice(dropped);
  saveHistoryToFile(trimmed, sessionId);
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
  return rotateHistory(data, sessionId);
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

// ==================== 任务级 Checkpoint ====================

export function readTaskCheckpoint(sessionId?: string): TaskCheckpoint | null {
  const file = getTaskCheckpointFile(sessionId);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn(`[memory] 读取任务 checkpoint 失败: ${(e as Error).message}`);
    return null;
  }
}

export function writeTaskCheckpoint(checkpoint: TaskCheckpoint, sessionId?: string): void {
  const file = getTaskCheckpointFile(sessionId);
  fs.writeFileSync(file, JSON.stringify(checkpoint, null, 2), 'utf-8');
}

export function createTaskCheckpoint(sessionId: string, goal: string): TaskCheckpoint {
  return {
    sessionId,
    goal,
    steps: [],
    currentStep: 0,
    totalSteps: 0,
    modifiedFiles: [],
    blockers: [],
    lastUpdated: new Date().toISOString(),
  };
}

export function addTaskStep(checkpoint: TaskCheckpoint, description: string): TaskStep {
  const step: TaskStep = {
    id: checkpoint.steps.length,
    description,
    status: 'pending',
    startedAt: new Date().toISOString(),
  };
  checkpoint.steps.push(step);
  checkpoint.totalSteps = checkpoint.steps.length;
  checkpoint.lastUpdated = new Date().toISOString();
  return step;
}

export function updateTaskStep(checkpoint: TaskCheckpoint, stepId: number, updates: Partial<TaskStep>): void {
  const step = checkpoint.steps.find(s => s.id === stepId);
  if (!step) return;
  Object.assign(step, updates);
  if (updates.status === 'done' || updates.status === 'failed') {
    step.completedAt = new Date().toISOString();
  }
  checkpoint.currentStep = Math.max(checkpoint.currentStep, stepId + 1);
  checkpoint.lastUpdated = new Date().toISOString();
}

export function addModifiedFile(checkpoint: TaskCheckpoint, filePath: string): void {
  if (!checkpoint.modifiedFiles.includes(filePath)) {
    checkpoint.modifiedFiles.push(filePath);
  }
  checkpoint.lastUpdated = new Date().toISOString();
}

export function addBlocker(checkpoint: TaskCheckpoint, stepId: number, reason: string): void {
  checkpoint.blockers.push({
    stepId,
    reason,
    timestamp: new Date().toISOString(),
  });
  checkpoint.lastUpdated = new Date().toISOString();
}
