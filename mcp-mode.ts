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
import { loadConfig } from './src/config';

// ==================== MCP Server 主函数 ====================

export async function mcpMode(): Promise<void> {
  // 动态 import MCP SDK（可选依赖，CLI 模式不加载）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let McpServer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let StdioServerTransport: any;
  try {
    // @ts-ignore - @modelcontextprotocol/sdk 为可选依赖，运行时动态加载
    const mcpModule = await import('@modelcontextprotocol/sdk');
    McpServer = mcpModule.McpServer || mcpModule.default?.McpServer;
    StdioServerTransport = mcpModule.StdioServerTransport || mcpModule.default?.StdioServerTransport;
  } catch {
    console.error('[MCP] 错误: 未安装 @modelcontextprotocol/sdk，请运行 npm install @modelcontextprotocol/sdk');
    process.exit(1);
  }

  // 初始化配置（复用 src/config.ts 的 loadConfig，消除重复逻辑）
  const { config, warnings } = loadConfig();
  for (const w of warnings) console.error(`[MCP 警告] ${w}`);
  const openai = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  const tools: Tool[] = createBuiltinTools();
  initMcpTools(tools, (cmd, timeout) => toolRunShell({ command: cmd, timeout }));
  const sessionId = generateSessionId();
  const historyData = initHistory(sessionId);

  // 初始化 appState（统一状态管理，不再维护独立 conversationHistory）
  appState.init({
    openai,
    config,
    currentSessionId: sessionId,
    conversationHistory: [],
    tools,
    historyData,
  });

  // 创建 MCP Server
  const server = new McpServer({
    name: 'mi-cc',
    version: '2.3.0',
  });

  // ---------- 工具: agent_execute ----------
  server.tool(
    'agent_execute',
    '执行 Agent 任务：劫持 console.log 收集输出，调用完整的 agentLoop 处理用户输入',
    {
      input: { type: 'string', description: '用户输入的任务描述' },
    },
    async ({ input }: { input: string }) => {
      // 劫持 console.log 收集输出
      const logs: string[] = [];
      const origLog = console.log;
      const origError = console.error;
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      console.error = (...args: unknown[]) => logs.push('[stderr] ' + args.map(String).join(' '));

      try {
        // 动态 import agentLoop 相关模块
        const { buildSystemPrompt, callLLM, compactContext } = await import('./src/llm-core');

        // 构建 system prompt，使用 appState 统一管理对话历史
        const systemPrompt = buildSystemPrompt(input);
        appState.get('conversationHistory').push({ role: 'user', content: input });

        const messages: Message[] = [
          { role: 'system', content: systemPrompt },
          ...appState.get('conversationHistory'),
        ] as Message[];

        let response = await callLLM(messages);
        let iterations = 0;
        let finalContent = '';

        while (true) {
          appState.get('conversationHistory').push(response);
          if (response.content) finalContent += response.content + '\n';

          const toolCalls = response.tool_calls;
          if (!toolCalls || toolCalls.length === 0) break;

          iterations++;
          if (iterations > 20) break;

          for (const tc of toolCalls) {
            let args: Record<string, unknown>;
            try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
            const result = await executeToolCall(tools, tc.function.name, args);
            appState.get('conversationHistory').push({ role: 'tool', content: result, tool_call_id: tc.id });
          }

          response = await callLLM([
            { role: 'system', content: buildSystemPrompt() },
            ...appState.get('conversationHistory'),
          ]);
        }

        return {
          content: [{ type: 'text' as const, text: finalContent || logs.join('\n') || '(无输出)' }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `[MCP 错误] agent_execute 失败: ${(error as Error).message}` }],
          isError: true,
        };
      } finally {
        // 确保 console 一定恢复
        console.log = origLog;
        console.error = origError;
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
