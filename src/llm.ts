import OpenAI from 'openai';
import type { Message } from '../types';

// ========== LLM Provider 接口 ==========

export interface ChatParams {
  messages: Message[];
  model?: string;
  maxTokens?: number;
  tools?: OpenAI.Chat.ChatCompletionTool[];
  toolChoice?: OpenAI.Chat.ChatCompletionToolChoiceOption;
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: Message;
  raw: unknown;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  chat(params: ChatParams): Promise<ChatResponse>;
  healthCheck?(): Promise<boolean>;
}

// ========== OpenAI Provider 实现 ==========

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';
  readonly name: string;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: { apiKey: string; baseURL?: string; model: string }) {
    this.name = opts.baseURL || 'OpenAI';
    this.model = opts.model;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create(
      {
        model: params.model || this.model,
        messages: params.messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: params.tools,
        tool_choice: params.toolChoice,
        max_tokens: params.maxTokens,
      },
      params.signal ? { signal: params.signal } : undefined,
    );
    return {
      message: response.choices[0].message as unknown as Message,
      raw: response,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 2,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ========== Provider 工厂 ==========

export function createLLMProvider(opts: {
  apiKey: string;
  baseURL?: string;
  model: string;
}): LLMProvider {
  return new OpenAIProvider(opts);
}
