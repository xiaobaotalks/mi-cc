import * as fs from 'fs';
import type OpenAI from 'openai';
import type { Message, Tool, HistoryRecord, Config } from '../types';
import { isSummaryMessage } from '../compress';
import {
  addOrUpdateSession,
  ensureSessionDir,
  getSessionFile,
  readCheckpoint,
  initHistory,
} from '../memory';
import { loadCompressState } from '../compress';
import type { ProviderRouter } from './router';

// ========== AppState 单例 ==========

export const DEFAULT_MAX_RAW_TURNS = 20;

class AppState {
  private static _instance: AppState;

  // 状态字段
  openai!: OpenAI;
  config!: Config;
  currentSessionId!: string;
  conversationHistory: Message[] = [];
  tools!: Tool[];
  historyData: HistoryRecord[] = [];
  maxRawTurns: number = DEFAULT_MAX_RAW_TURNS;
  /** 多 Provider 故障转移路由器（可选，未配置时为 null） */
  router: ProviderRouter | null = null;
  /** 待发送的图片（由 /image 命令添加，下一次用户输入时附加到消息中） */
  pendingImages: Array<{ path: string; base64: string; mimeType: string }> = [];
  /** 待发送的文本消息（由 /image <path> <text> 命令设置，斜杠命令处理后自动发送） */
  pendingMessage: string | null = null;

  // 变更订阅
  private _listeners: Map<string, Set<(value: unknown) => void>> = new Map();

  static get instance(): AppState {
    if (!AppState._instance) {
      AppState._instance = new AppState();
    }
    return AppState._instance;
  }

  /** 设置字段并触发订阅 */
  set<K extends keyof AppState>(key: K, value: AppState[K]): void {
    (this as AppState)[key] = value;
    this._notify(key, value);
  }

  get<K extends keyof AppState>(key: K): AppState[K] {
    return this[key];
  }

  /** 订阅字段变更 */
  subscribe<K extends keyof AppState>(
    key: K,
    cb: (value: AppState[K]) => void,
  ): () => void {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    this._listeners.get(key)!.add(cb as (value: unknown) => void);
    return () => this._listeners.get(key)?.delete(cb as (value: unknown) => void);
  }

  private _notify(key: string, value: unknown): void {
    this._listeners.get(key)?.forEach(cb => cb(value));
  }

  /** 初始化全部状态（一次调用） */
  init(initial: {
    openai: OpenAI;
    config: Config;
    currentSessionId: string;
    conversationHistory: Message[];
    tools: Tool[];
    historyData: HistoryRecord[];
  }): void {
    this.openai = initial.openai;
    this.config = initial.config;
    this.currentSessionId = initial.currentSessionId;
    this.conversationHistory = initial.conversationHistory;
    this.tools = initial.tools;
    this.historyData = initial.historyData;
  }

  /** 清空对话历史（保留系统消息） */
  clearHistory(): void {
    const systemMsgs = this.conversationHistory.filter(m => m.role === 'system');
    this.conversationHistory = systemMsgs;
  }

  /** 获取当前原始消息（排除摘要层） */
  getRawMessages(): Message[] {
    return this.conversationHistory.filter(m => m.role !== 'system' || !isSummaryMessage(m));
  }

  /** 获取摘要层消息 */
  getSummaryMessages(): Message[] {
    return this.conversationHistory.filter(m => m.role === 'system' && isSummaryMessage(m));
  }

  /** 切换到新会话 */
  switchSession(newSessionId: string): void {
    // 保存当前会话状态
    if (this.currentSessionId) {
      addOrUpdateSession(this.currentSessionId, '切换会话', this.conversationHistory.length);
    }

    // 加载新会话状态
    this.currentSessionId = newSessionId;
    ensureSessionDir(newSessionId);

    // 从会话目录加载历史
    this.historyData = initHistory(newSessionId);

    // 恢复压缩摘要层
    const compressState = loadCompressState(newSessionId);
    const summaryMessages: Message[] = compressState.summaries.map(s => ({
      role: 'system' as const,
      content: `[历史摘要 L${s.level} @ ${s.createdAt}]\n${s.text}`,
    }));

    // 从会话目录加载对话历史（history.json 中的原始消息）
    const historyFile = getSessionFile(newSessionId, 'history.json');
    const rawMessages: Message[] = [];
    try {
      if (fs.existsSync(historyFile)) {
        const records = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        for (const r of records) {
          if (r.role === 'user' || r.role === 'assistant') {
            rawMessages.push({ role: r.role, content: r.content });
          } else if (r.role === 'tool' && r.tool_call_id) {
            // 保留 tool 消息，否则后续 LLM 调用会缺少 tool_call_id 对应的响应
            rawMessages.push({ role: 'tool', content: r.content, tool_call_id: r.tool_call_id });
          }
        }
      }
    } catch {
      // 历史文件损坏时静默跳过
    }

    // 合并摘要层 + 原始消息
    this.conversationHistory = [...summaryMessages, ...rawMessages];

    const checkpoint = readCheckpoint(newSessionId);
    if (checkpoint) {
      console.log(`[会话恢复] ${newSessionId}: ${checkpoint.task}`);
      console.log(`[会话恢复] 摘要 ${summaryMessages.length} 层, 原始消息 ${rawMessages.length} 条`);
    }
  }
}

export const appState = AppState.instance;
