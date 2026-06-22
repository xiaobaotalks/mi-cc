# mi-cc 功能改进详细设计

> 对应升级计划: [plan.md](./plan.md)  
> 日期: 2026-06-22

---

## 目录

1. [MCP Server 模式](#1-mcp-server-模式)
2. [LLM 故障转移](#2-llm-故障转移)
3. [Loop 模式优化](#3-loop-模式优化)
4. [安全加固](#4-安全加固)
5. [状态管理重构](#5-状态管理重构)
6. [配置管理](#6-配置管理)
7. [终端体验](#7-终端体验)
8. [代码库理解](#8-代码库理解)

---

## 1. MCP Server 模式

### 1.1 设计原则

- **零改动核心逻辑**：现有 `agentLoop()` / `callLLM()` / `buildSystemPrompt()` 等函数完全不变
- **最小代码增量**：新增 ~83 行代码（一个 `mcp-mode.ts` + 入口分支）
- **双模式共存**：`mi-cc` 走 CLI 模式，`mi-cc --mcp` 走 MCP Server 模式

### 1.2 架构

```
mi-cc
├── CLI 模式（现有）
│   └── readline → agentLoop() → console.log 输出
│
└── MCP 模式（新增）
    ├── StdioServerTransport ←→ JSON-RPC 2.0
    ├── agent_execute 工具 → 劫持 console.log → 收集输出返回
    └── 单工具透传 → executeToolCall() 直接返回
```

### 1.3 核心实现

```typescript
// mcp-mode.ts（~80 行）
async function mcpMode() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  // 复用现有初始化
  const config = initConfig();
  const openai = initOpenAI(config);
  const tools = createBuiltinTools();
  initMcpTools(tools, (cmd, timeout) => toolRunShell({ command: cmd, timeout }));

  const server = new Server(
    { name: 'mi-cc', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  // 万能工具：执行完整任务
  server.setRequestHandler('tools/call', async ({ params }) => {
    if (params.name === 'agent_execute') {
      const outputs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => outputs.push(args.join(' '));

      await agentLoop(params.arguments.task);  // 完全复用现有逻辑

      console.log = originalLog;
      return { content: [{ type: 'text', text: outputs.join('\n') }] };
    }

    // 单工具透传
    const result = await executeToolCall(tools, params.name, params.arguments);
    return { content: [{ type: 'text', text: result }] };
  });

  await server.connect(new StdioServerTransport());
}
```

### 1.4 暴露的能力

| MCP 类型 | 名称 | 功能 | 对应现有代码 |
|----------|------|------|-------------|
| tool | `agent_execute` | 执行完整编程任务（内部自主规划、工具调用、压缩） | [agentLoop()](file:///workspace/mimo-cli.ts#L339-L398) |
| tool | `readFile` | 读取文件 | [toolReadFile()](file:///workspace/tools.ts#L31-L46) |
| tool | `writeFile` | 写入文件 | [toolWriteFile()](file:///workspace/tools.ts#L48-L61) |
| tool | `runShell` | 执行 Shell | [toolRunShell()](file:///workspace/tools.ts#L72-L105) |
| tool | `git` | Git 操作 | [toolGit()](file:///workspace/tools.ts#L107-L111) |
| tool | `skill_match` | 技能匹配 | [matchSkill()](file:///workspace/skills.ts#L160-L171) |
| resource | `memory://project` | 项目记忆 | [readMemory()](file:///workspace/memory.ts#L68-L92) |
| resource | `memory://notes` | 笔记 | [readNotes()](file:///workspace/memory.ts#L111-L118) |
| resource | `memory://checkpoint` | 会话检查点 | [readCheckpoint()](file:///workspace/memory.ts#L24-L50) |

### 1.5 宿主接入示例

**OpenClaw 配置**:

```json
{
  "mcpServers": {
    "mi-cc": {
      "command": "npx",
      "args": ["-y", "mimo-cli@latest", "--mcp"],
      "env": {
        "API_KEY": "${env:MIMO_API_KEY}",
        "MODEL": "mimo-v2.5-pro"
      }
    }
  }
}
```

**Cursor 配置**:

```json
{
  "mcpServers": {
    "mi-cc": {
      "command": "mi-cc",
      "args": ["--mcp"]
    }
  }
}
```

---

## 2. LLM 故障转移

### 2.1 问题场景

- API Key 额度用完
- 模型供应商服务不可用
- 速率限制（429）
- 网络超时

### 2.2 设计

```
用户请求 → ProviderRouter
              ├── Provider #1 (mimo-v2.5-pro) → 401/额度用完 → 标记 unhealthy
              ├── Provider #2 (gpt-4o-mini)   → 429/限速    → 冷却 30s
              ├── Provider #3 (claude-3.5)    → 5xx/超时    → 指数退避
              └── 全部失败 → 返回错误提示
```

### 2.3 配置格式

```bash
# .env
# 主配置
API_KEY=sk-mimo-xxxx
BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MODEL=mimo-v2.5-pro

# 备选配置（索引命名）
API_KEY_1=sk-openai-xxxx
BASE_URL_1=https://api.openai.com/v1
MODEL_1=gpt-4o-mini

API_KEY_2=sk-anthropic-xxxx
BASE_URL_2=https://api.anthropic.com/v1
MODEL_2=claude-3-5-sonnet-20241022
```

### 2.4 错误分类与策略

| HTTP 状态 | 错误类型 | 策略 |
|-----------|----------|------|
| 401 | Key 失效 | 立即标记 unhealthy，切换下一个 |
| 429 | 速率限制 | 冷却 30s，期间切换到其他 provider |
| 5xx | 服务不可用 | 指数退避重试（500ms → 1s → 2s），仍失败则切换 |
| timeout | 网络超时 | 同 5xx |
| context_length_exceeded | token 超限 | **不切换 provider**，走现有压缩逻辑 |

### 2.5 Provider 健康状态

```typescript
interface ProviderHealth {
  id: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastErrorAt?: number;
  lastErrorType?: string;
  cooldownUntil?: number;
  consecutiveFailures: number;
}
```

- 冷却恢复后发送健康检查（空 ping 请求），确认恢复才重新使用
- 健康状态持久化到 `provider-health.json`
- 切换时通知用户：`[Provider] mimo-v2.5-pro 额度用尽，已切换到 gpt-4o-mini`

---

## 3. Loop 模式优化

### 3.1 现状问题

- `conversationHistory` 无限增长，依赖压缩兜底
- System Prompt 每次全量重建
- checkpoint 只在对话结束时写入
- 早期对话压缩为摘要后，LLM 失去细节理解

### 3.2 三层架构

```
长期记忆（Long-Term Memory）
├── MEMORY.md（项目规则/架构决策）
├── skill-lib.md（技能库）
└── history.json（完整历史，可检索）
        ↓ 按需检索（RAG / 关键词搜索）

工作记忆（Working Memory）
├── conversationHistory（最近 K 轮原文，如 20 轮）
├── 摘要层 L0/L1/L2（早期对话的结构化摘要）
└── checkpoint（当前任务进度）
        ↓ 每轮注入

Loop 控制层
├── Planner：轻量模型 → 生成执行计划
├── Actor：主模型 → 执行单步工具调用
├── Reviewer：轻量模型 → 验证结果
└── 循环预算：max_iterations + token_budget
```

### 3.3 滚动窗口摘要

```
对话轮次:  1   2   3   4   5   6   7   8   9   10  11  12  13  14  15  16  17  18  19  20  21  22  23
          ├───────────────────────────────────────┤├───────────────────────────────────────┤├────────────┤
          │           摘要 L1（第1-10轮）           ││           摘要 L0（第11-20轮）          ││  原文保留   │
          │  "用户要求重构 utils.ts，已读取文件..."  ││  "发现重复逻辑在 formatDate 和 parseDate" ││ 第21-23轮  │
          └───────────────────────────────────────┘└───────────────────────────────────────┘└────────────┘
```

**规则**:
- 固定保留 K 轮原文（如 20 轮）
- 超窗内容自动摘要为 L0
- L0 超窗后，L0 + 更早内容合并摘要为 L1
- 摘要层**只读**，不可重写
- 每层记录：level / text / createdAt / coversFrom / coversTo / tokenCount

### 3.4 任务级 Checkpoint

```typescript
interface TaskCheckpoint {
  taskId: string;
  goal: string;
  currentStep: number;
  totalSteps: number;
  completed: string[];
  pending: string[];
  blockers: string[];
  modifiedFiles: string[];
  lastUpdated: string;
}
```

- 每步工具调用完成**自动写入**
- 崩溃重启后从 `blockers` 恢复上下文
- 支持 `/checkpoint` 命令手动查看/恢复

### 3.5 System Prompt 增量构建

| 层级 | 内容 | 更新频率 | 实现 |
|------|------|----------|------|
| 固定层 | 系统角色描述、可用工具清单、技能库 | 启动时缓存，skill-lib.md mtime 变化时刷新 | `buildSystemPrompt` 拆分缓存 |
| 动态层 | 会话 ID、时间、匹配技能、当前 checkpoint | 每轮更新 | 每次重建 |
| 按需层 | MEMORY.md 全文、历史搜索结果、notes | LLM 主动请求时注入 | 新增 `read_memory` / `search_history` 工具 |

**按需层通过工具调用获取**，减少 60-80% 的 system prompt token 开销。

---

## 4. 安全加固

### 4.1 Shell 命令白名单

**默认白名单**（开发常用）:

```typescript
const SHELL_WHITELIST = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'awk', 'sed',
  'npm', 'node', 'npx', 'yarn', 'pnpm',
  'git', 'tsc', 'eslint', 'prettier',
  'mkdir', 'touch', 'cp', 'mv', 'rm',
  'python', 'python3', 'pip',
  'docker', 'docker-compose',
  'curl', 'wget',  // 限制：不允许管道到 bash
]);
```

**管道限制**:
- 允许：`cat file | grep pattern`
- 禁止：`curl ... | bash`、`wget ... | sh`

### 4.2 文件路径限制

```typescript
function normalizePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd)) {
    throw new Error('路径超出项目目录');
  }
  return resolved;
}
```

- 禁止 `../` 逃逸到项目目录外
- 禁止访问 `/etc/passwd`、`~/.ssh` 等敏感路径
- `.env`、私钥文件写入前确认

### 4.3 审计日志

```typescript
// audit.log 格式
[2026-06-22T10:30:00Z] [session_xxx] [runShell] ls -la
[2026-06-22T10:30:01Z] [session_xxx] [runShell] ✓ success (120ms)
[2026-06-22T10:31:00Z] [session_xxx] [writeFile] src/utils.ts (2048 bytes)
[2026-06-22T10:31:01Z] [session_xxx] [writeFile] ✓ success
```

### 4.4 API Key 加密存储

```typescript
// 使用系统 keychain（keytar）或文件加密
import { safeStorage } from 'electron';  // 或 node-keytar

async function saveApiKey(key: string): Promise<void> {
  const encrypted = await safeStorage.encryptString(key);
  fs.writeFileSync('.env.key', encrypted);
}

async function loadApiKey(): Promise<string> {
  const encrypted = fs.readFileSync('.env.key');
  return safeStorage.decryptString(encrypted);
}
```

---

## 5. 状态管理重构

### 5.1 现状

```typescript
// mimo-cli.ts 全局变量
let openai: OpenAI;
let config: Config;
let currentSessionId: string;
let conversationHistory: Message[] = [];
let tools: Tool[] = [];
let historyData: HistoryRecord[] = [];
```

### 5.2 目标：AppState 单例

```typescript
// core/app-state.ts
class AppState {
  private static instance: AppState;

  private _openai: OpenAI;
  private _config: Config;
  private _sessionId: string;
  private _conversation: Message[] = [];
  private _tools: Tool[] = [];
  private _history: HistoryRecord[] = [];
  private _listeners: Map<string, Set<() => void>> = new Map();

  static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState();
    }
    return AppState.instance;
  }

  get config(): Config { return this._config; }
  set config(v: Config) { this._config = v; this.emit('config'); }

  get conversation(): Message[] { return [...this._conversation]; }
  pushMessage(msg: Message): void {
    this._conversation.push(msg);
    this.emit('conversation');
  }
  replaceConversation(msgs: Message[]): void {
    this._conversation = [...msgs];
    this.emit('conversation');
  }

  on(event: string, cb: () => void): () => void {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event)!.add(cb);
    return () => this._listeners.get(event)!.delete(cb);
  }

  private emit(event: string): void {
    this._listeners.get(event)?.forEach(cb => cb());
  }
}
```

### 5.3 SlashContext 改造

```typescript
// commands.ts
export interface SlashContext {
  state: AppState;  // 替代分散的字段
}

// 不再需要 syncCtx() 手动同步
```

---

## 6. 配置管理

### 6.1 配置层级

```
默认值
  ↓ 覆盖
.env 文件
  ↓ 覆盖
环境变量
  ↓ 覆盖
CLI 参数（--model, --session）
  ↓ 覆盖
运行时 /connect 命令
```

### 6.2 Schema 校验（zod）

```typescript
// core/config.ts
import { z } from 'zod';

const ConfigSchema = z.object({
  apiKey: z.string().min(1, 'API Key 不能为空'),
  baseUrl: z.string().url('Base URL 格式错误'),
  model: z.string().min(1),
  maxTokens: z.number().int().positive().max(2_000_000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const raw = {
    apiKey: process.env.API_KEY || '',
    baseUrl: process.env.BASE_URL || 'https://api.openai.com/v1',
    model: process.env.MODEL || 'gpt-4o-mini',
    maxTokens: parseInt(process.env.MAX_TOKEN || '8000', 10),
  };
  return ConfigSchema.parse(raw);  // 校验失败抛错，提示具体字段
}
```

### 6.3 多 Provider 配置

```typescript
// 支持 API_KEY_N / BASE_URL_N / MODEL_N 格式
function loadProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  const main = loadConfig();
  providers.push({ id: 'primary', ...main });

  for (let i = 1; ; i++) {
    const key = process.env[`API_KEY_${i}`];
    if (!key) break;
    providers.push({
      id: `fallback_${i}`,
      apiKey: key,
      baseUrl: process.env[`BASE_URL_${i}`] || main.baseUrl,
      model: process.env[`MODEL_${i}`] || main.model,
      maxTokens: main.maxTokens,
    });
  }
  return providers;
}
```

---

## 7. 终端体验

### 7.1 TUI 渲染（chalk 方案，轻量）

```typescript
import chalk from 'chalk';
import { indentBlock, previewResult } from './cli-utils';

function renderToolCall(toolName: string, args: Record<string, unknown>, result: string, elapsed: number) {
  const box = `
${chalk.gray('┌─')} ${chalk.cyan('🔧')} ${chalk.bold(toolName)}${chalk.gray(`(${JSON.stringify(args)})`)}
${chalk.gray('├─')} ${chalk.green('✓')} ${chalk.gray(`${elapsed}ms`)}
${chalk.gray('│')} ${indentBlock(previewResult(result), chalk.gray('│ '))}
${chalk.gray('└─')}
  `;
  console.log(box);
}

function renderAssistant(content: string) {
  console.log(`\n${chalk.blue('💬')} ${chalk.bold('助手')}\n${content}\n`);
}
```

### 7.2 流式输出

```typescript
async function callLLMStream(messages: Message[], onChunk: (chunk: string) => void): Promise<void> {
  const stream = await openai.chat.completions.create({
    model: config.model,
    messages,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) onChunk(content);
  }
}

// 使用
process.stdout.write(chalk.blue('💬 助手: '));
await callLLMStream(messages, (chunk) => {
  process.stdout.write(chunk);  // 打字机效果
});
process.stdout.write('\n\n');
```

### 7.3 多会话管理

```typescript
// 新增斜杠命令
/session list          # 列出所有会话
/session switch <id>   # 切换会话
/session rename <id> <name>  # 重命名
/session new           # 新建会话
/session export <id>   # 导出为 JSON
/session import <file> # 从 JSON 导入
```

**会话存储结构**:

```
sessions/
├── session_xxx/
│   ├── history.json
│   ├── checkpoint.md
│   └── compress-state.json
├── session_yyy/
│   └── ...
└── index.json  # 会话元数据列表
```

---

## 8. 代码库理解

### 8.1 项目索引（/index）

```typescript
async function indexProject(): Promise<ProjectIndex> {
  const files = await glob('**/*.{ts,js,json,md}', { ignore: ['node_modules/**', 'dist/**'] });
  const index: ProjectIndex = { files: [], functions: [], dependencies: [] };

  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    index.files.push({
      path: file,
      size: content.length,
      summary: await generateFileSummary(content),  // 轻量模型生成
    });

    // 提取函数签名（简单正则）
    const functions = content.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g) || [];
    index.functions.push(...functions.map(f => ({ file, name: f })));
  }

  // 提取 package.json 依赖
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf-8'));
  index.dependencies = Object.keys(pkg.dependencies || {});

  return index;
}
```

### 8.2 RAG 问答（/ask）

```typescript
async function askProject(question: string): Promise<string> {
  const index = await loadIndex();  // 加载已生成的索引

  // 简单关键词匹配（未来可升级为向量检索）
  const relevantFiles = index.files.filter(f =>
    question.toLowerCase().includes(f.path.toLowerCase()) ||
    f.summary.toLowerCase().includes(question.toLowerCase())
  );

  const context = relevantFiles
    .slice(0, 5)
    .map(f => `## ${f.path}\n${f.summary}`)
    .join('\n\n');

  const prompt = `基于以下项目信息回答问题：\n\n${context}\n\n问题：${question}`;
  return callLLM([{ role: 'user', content: prompt }]);
}
```

### 8.3 重构建议（/refactor）

```typescript
async function suggestRefactor(target: string): Promise<RefactorSuggestion[]> {
  const content = await fs.readFile(target, 'utf-8');
  const prompt = `分析以下代码，给出重构建议（提取函数、重命名、简化逻辑等）：\n\n${content}`;
  const response = await callLLM([{ role: 'user', content: prompt }]);
  return parseRefactorSuggestions(response);
}
```

---

*文档版本: 2026-06-22*
