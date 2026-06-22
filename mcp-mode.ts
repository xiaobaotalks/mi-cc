/**
 * MCP Server 模式
 *
 * 将 mi-cc 作为 MCP Server 暴露，供 Claude Desktop / 其他 MCP Client 调用。
 * 使用 StdioServerTransport，通过 JSON-RPC 2.0 通信。
 *
 * 暴露的工具：
 *   - agent_execute: 劫持 console.log 收集输出，调用 agentLoop
 *   - readFile / writeFile / runShell / git: 通过 executeToolCall 透传
 *   - skill_match: 调用 matchSkill
 *
 * 暴露的资源：
 *   - memory://project  -> MEMORY.md
 *   - memory://notes    -> notes.md
 *   - memory://checkpoint -> checkpoint.md
 */

import * as fs from 'fs';
import {
  createBuiltinTools,
  executeToolCall,
  toolRunShell,
} from './tools';
import {
  initMcpTools,
} from './commands';
import {
  readMemory,
  readNotes,
  readCheckpoint,
  initHistory,
  saveHistory,
  generateSessionId,
  MEMORY_FILE,
  NOTES_FILE,
  CHECKPOINT_FILE,
} from './memory';
import { matchSkill, formatSkillForPrompt } from './skills';
import type { Tool, Config } from './types';
import OpenAI from 'openai';
import { appState } from './src/state';

// ==================== 初始化（复用 mimo-cli 的配置逻辑） ====================

function initConfig(): Config {
  // 复用 mimo-cli 的配置逻辑（不直接 import 避免循环）
  const dotenv = require('dotenv');
  dotenv.config({ path: '.env' });
  const model = process.env.MODEL || 'gpt-4o-mini';
  const maxTokens = process.env.MAX_TOKEN ? parseInt(process.env.MAX_TOKEN, 10) : 8000;
  return {
    apiKey: process.env.API_KEY || '',
    baseUrl: process.env.BASE_URL || 'https://api.openai.com/v1',
    model,
    maxTokens,
  };
}

function initOpenAI(cfg: Config): OpenAI {
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  });
}

// ==================== MCP Server 主函数 ====================

export async function mcpMode(): Promise<void> {
  // 动态 import MCP SDK（可选依赖，CLI 模式不加载）
  let McpServer: any;
  let StdioServerTransport: any;
  try {
    const mcpModule = await import('@modelcontextprotocol/sdk');
    McpServer = mcpModule.McpServer || (mcpModule as any).default?.McpServer;
    StdioServerTransport = mcpModule.StdioServerTransport || (mcpModule as any).default?.StdioServerTransport;
  } catch {
    console.error('[MCP] 错误: 未安装 @modelcontextprotocol/sdk，请运行 npm install @modelcontextprotocol/sdk');
    process.exit(1);
  }

  // 初始化
  const config = initConfig();
  const openai = initOpenAI(config);
  const tools: Tool[] = createBuiltinTools();
  initMcpTools(tools, (cmd, timeout) => toolRunShell({ command: cmd, timeout }));
  const sessionId = generateSessionId();
  const historyData = initHistory();

  // 初始化 appState
  appState.init({
    openai,
    config,
    currentSessionId: sessionId,
    conversationHistory: [],
    tools,
    historyData,
  });

  // agentLoop 需要的共享状态（MCP 模式下简化）
  let conversationHistory: any[] = [];

  // 创建 MCP Server
  const server = new McpServer({
    name: 'mi-cc',
    version: '1.1.0',
  });

  // ---------- 工具: agent_execute ----------
  server.tool(
    'agent_execute',
    '执行 Agent 任务：劫持 console.log 收集输出，调用完整的 agentLoop 处理用户输入',
    {
      input: { type: 'string', description: '用户输入的任务描述' },
    },
    async ({ input }: { input: string }) => {
      try {
        // 劫持 console.log 收集输出
        const logs: string[] = [];
        const origLog = console.log;
        const origError = console.error;
        console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
        console.error = (...args: unknown[]) => logs.push('[stderr] ' + args.map(String).join(' '));

        // 动态 import agentLoop 相关模块
        const { buildSystemPrompt, callLLM, compactContext } = await import('./mimo-cli') as any;

        // 构建 system prompt
        const systemPrompt = buildSystemPrompt(input);
        conversationHistory.push({ role: 'user', content: input });

        const messages = [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
        ];

        let response = await callLLM(messages);
        let iterations = 0;
        let finalContent = '';

        while (true) {
          conversationHistory.push(response);
          if (response.content) finalContent += response.content + '\n';

          const toolCalls = response.tool_calls;
          if (!toolCalls || toolCalls.length === 0) break;

          iterations++;
          if (iterations > 20) break;

          for (const tc of toolCalls) {
            let args: Record<string, unknown>;
            try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
            const result = await executeToolCall(tools, tc.function.name, args);
            conversationHistory.push({ role: 'tool', content: result, tool_call_id: tc.id });
          }

          response = await callLLM([
            { role: 'system', content: buildSystemPrompt() },
            ...conversationHistory,
          ]);
        }

        // 恢复 console
        console.log = origLog;
        console.error = origError;

        return {
          content: [{ type: 'text' as const, text: finalContent || logs.join('\n') || '(无输出)' }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `[MCP 错误] agent_execute 失败: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---------- 工具: 原子工具透传 ----------
  const atomicToolNames = ['readFile', 'writeFile', 'runShell', 'git'];
  const atomicToolDescs: Record<string, string> = {
    readFile: '读取文件内容',
    writeFile: '写入文件内容',
    runShell: '执行 Shell 命令',
    git: '执行 Git 操作',
  };
  const atomicToolParams: Record<string, any> = {
    readFile: { path: { type: 'string', description: '文件路径' } },
    writeFile: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '文件内容' } },
    runShell: { command: { type: 'string', description: 'Shell 命令' }, timeout: { type: 'number', description: '超时毫秒数' } },
    git: { operation: { type: 'string', description: 'Git 操作' }, params: { type: 'array', items: { type: 'string' } } },
  };
  const atomicToolRequired: Record<string, string[]> = {
    readFile: ['path'],
    writeFile: ['path', 'content'],
    runShell: ['command'],
    git: ['operation'],
  };

  for (const toolName of atomicToolNames) {
    server.tool(
      toolName,
      atomicToolDescs[toolName],
      {
        type: 'object',
        properties: atomicToolParams[toolName],
        required: atomicToolRequired[toolName],
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await executeToolCall(tools, toolName, args);
          return { content: [{ type: 'text' as const, text: result }] };
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: `[MCP 错误] ${toolName} 失败: ${(error as Error).message}` }],
            isError: true,
          };
        }
      },
    );
  }

  // ---------- 工具: skill_match ----------
  server.tool(
    'skill_match',
    '匹配与输入文本最相关的技能',
    {
      text: { type: 'string', description: '输入文本' },
      topN: { type: 'number', description: '返回前 N 个匹配结果（默认 2）' },
    },
    async ({ text, topN }: { text: string; topN?: number }) => {
      try {
        const matched = matchSkill(text, topN || 2);
        const formatted = formatSkillForPrompt(matched);
        return {
          content: [{ type: 'text' as const, text: formatted || '(无匹配技能)' }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `[MCP 错误] skill_match 失败: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---------- 资源: memory:// ----------
  const resourceMap: Record<string, { file: string; description: string }> = {
    'memory://project': { file: MEMORY_FILE, description: '项目记忆 (MEMORY.md)' },
    'memory://notes': { file: NOTES_FILE, description: '笔记 (notes.md)' },
    'memory://checkpoint': { file: CHECKPOINT_FILE, description: '会话检查点 (checkpoint.md)' },
  };

  for (const [uri, info] of Object.entries(resourceMap)) {
    server.resource(
      uri,
      info.description,
      async () => {
        try {
          const content = fs.existsSync(info.file)
            ? fs.readFileSync(info.file, 'utf-8')
            : '(文件不存在)';
          return {
            contents: [{ uri, mimeType: 'text/markdown', text: content }],
          };
        } catch (error) {
          return {
            contents: [{ uri, mimeType: 'text/markdown', text: `[MCP 错误] 读取失败: ${(error as Error).message}` }],
          };
        }
      },
    );
  }

  // ==================== 启动 Server ====================

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 防止 process.exit 导致的连接中断，错误转为 stderr 输出
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[MCP 未捕获异常] ${err.message}\n`);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[MCP 未捕获拒绝] ${String(reason)}\n`);
  });
}
