/**
 * ProviderRouter - 多 Provider 故障转移路由器
 * 自动在多个 API Key 之间切换，支持 auth/rate_limit 立即切换和连续失败冷却
 */

import { createLLMProvider, type LLMProvider, type ChatParams, type ChatResponse } from './llm';
import type { Config } from '../types';

// ========== Provider 状态 ==========

export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ProviderStatus {
  config: ProviderConfig;
  state: 'healthy' | 'degraded' | 'unhealthy';
  lastErrorAt?: number;
  lastErrorType?: string;
  consecutiveFailures: number;
  cooldownUntil?: number; // timestamp
}

const COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟冷却
const MAX_FAILURES = 3; // 连续失败 3 次后进入冷却

// ========== ProviderRouter ==========

export class ProviderRouter {
  private providers: ProviderStatus[] = [];
  private currentIndex = 0;
  private config: Config;

  constructor(config: Config, providerConfigs: ProviderConfig[]) {
    this.config = config;
    // 主 Provider（来自 .env）
    this.providers = [
      {
        config: {
          id: 'primary',
          name: 'Primary',
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
        },
        state: 'healthy',
        consecutiveFailures: 0,
      },
    ];
    // 备用 Provider（从 .env 的 API_KEY_N 等读取）
    for (const p of providerConfigs) {
      if (p.apiKey) {
        this.providers.push({
          config: p,
          state: 'healthy',
          consecutiveFailures: 0,
        });
      }
    }
  }

  /** 获取当前激活的 Provider */
  getCurrent(): ProviderStatus {
    return this.providers[this.currentIndex];
  }

  /** 获取所有 Provider 状态摘要 */
  getAll(): ProviderStatus[] {
    return [...this.providers];
  }

  /** 执行带故障转移的 chat */
  async chat(params: ChatParams & { signal?: AbortSignal }): Promise<ChatResponse> {
    const attempts = this.providers.length;
    let lastError: Error | null = null;

    for (let i = 0; i < attempts; i++) {
      const idx = (this.currentIndex + i) % this.providers.length;
      const provider = this.providers[idx];

      // 跳过冷却中的 Provider
      if (provider.cooldownUntil && Date.now() < provider.cooldownUntil) {
        continue;
      }

      const llm = createLLMProvider({
        apiKey: provider.config.apiKey,
        baseURL: provider.config.baseUrl,
        model: provider.config.model,
      });

      try {
        const response = await llm.chat({
          ...params,
          model: provider.config.model,
        });

        // 成功：标记 healthy，重置失败计数
        provider.state = 'healthy';
        provider.consecutiveFailures = 0;
        provider.lastErrorAt = undefined;
        provider.lastErrorType = undefined;
        this.currentIndex = idx;

        return response;
      } catch (error) {
        lastError = error as Error;
        const errorType = this.classifyError(error);

        provider.lastErrorAt = Date.now();
        provider.lastErrorType = errorType;
        provider.consecutiveFailures++;

        if (errorType === 'auth' || errorType === 'rate_limit') {
          // Key 失效或限速 → 立即标记 unhealthy，切到下一个
          provider.state = 'unhealthy';
          provider.cooldownUntil = Date.now() + COOLDOWN_MS;
          this.currentIndex = (idx + 1) % this.providers.length;
          console.log(`[Provider] ${provider.config.name} 标记 ${errorType}，切换到下一个 Provider`);
          continue;
        }

        if (provider.consecutiveFailures >= MAX_FAILURES) {
          // 连续失败 → 进入冷却
          provider.state = 'degraded';
          provider.cooldownUntil = Date.now() + COOLDOWN_MS;
          this.currentIndex = (idx + 1) % this.providers.length;
          console.log(`[Provider] ${provider.config.name} 连续失败 ${MAX_FAILURES} 次，进入冷却`);
        }
      }
    }

    throw new Error(`所有 Provider 均失败: ${lastError?.message || 'unknown'}`);
  }

  /** 切换到指定 Provider（手动） */
  switchTo(idOrIndex: string | number): boolean {
    if (typeof idOrIndex === 'string') {
      const idx = this.providers.findIndex(p => p.config.id === idOrIndex);
      if (idx === -1) return false;
      this.currentIndex = idx;
    } else {
      if (idOrIndex < 0 || idOrIndex >= this.providers.length) return false;
      this.currentIndex = idOrIndex;
    }
    // 重置目标 Provider 状态
    this.providers[this.currentIndex].state = 'healthy';
    this.providers[this.currentIndex].cooldownUntil = undefined;
    this.providers[this.currentIndex].consecutiveFailures = 0;
    return true;
  }

  /** 从 .env 读取备用 Provider 配置 */
  static loadFromEnv(): ProviderConfig[] {
    const result: ProviderConfig[] = [];
    for (let i = 1; i <= 5; i++) {
      const key = process.env[`API_KEY_${i}`];
      if (key) {
        result.push({
          id: `p_${i}`,
          name: process.env[`PROVIDER_NAME_${i}`] || `Provider ${i}`,
          apiKey: key,
          baseUrl: process.env[`BASE_URL_${i}`] || '',
          model: process.env[`MODEL_${i}`] || '',
        });
      }
    }
    return result;
  }

  private classifyError(error: unknown): 'auth' | 'rate_limit' | 'server' | 'unknown' {
    const msg = (error as Error).message || String(error);
    if (/invalid.*api.*key|authentication|unauthorized|401/i.test(msg)) return 'auth';
    if (/rate.?limit|429|too.?many.?requests/i.test(msg)) return 'rate_limit';
    if (/500|502|503|504|econnrefused|econnreset|timeout/i.test(msg)) return 'server';
    return 'unknown';
  }
}
