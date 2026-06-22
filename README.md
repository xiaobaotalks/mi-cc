# mi-cc

最简化版智能编程助手，终端对话 + 工具调用 + 四层记忆 + 分层摘要压缩 + 经验蒸馏 + 技能库 + MCP Server 模式 + 多会话 + 多 Provider 故障转移 + 项目索引与问答。

> 默认对接国产大模型（小米 MiMo），兼容任意 OpenAI Chat Completions 协议通道（OpenAI / Claude / GLM / Moonshot / DeepSeek / 硅基流动等）。

## 安装

```bash
git clone https://github.com/xiaobaotalks/mi-cc.git
cd mi-cc
npm install
```

## 配置

```bash
cp .env.example .env
```

`.env` 内容示例（默认小米 MiMo，可切换为其他国产或 OpenAI 兼容通道）：

```
API_KEY=your_api_key_here
BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MODEL=mimo-v2.5-pro
# MAX_TOKEN 可选；不填则按模型自动推断
#   - MiMo / GPT-4o / Claude / GLM-4 / Moonshot-128k / DeepSeek 全部自动识别
#   - 未知模型默认 8000

# 可选：多 Provider 故障转移（主 Provider 失败时自动切换）
# API_KEY_1=sk-openai-xxxx
# BASE_URL_1=https://api.openai.com/v1
# MODEL_1=gpt-4o-mini
```

## 运行

```bash
# 方式一：本地开发
npm run dev

# 方式二：全局命令
npm link
mi-cc

# 方式三：指定会话
mi-cc -s my-session-id

# 方式四：MCP Server 模式（供 OpenClaw / Cursor / Claude 使用）
mi-cc --mcp
```

## 斜杠命令

输入 `/` 然后按 **Tab** 可补全命令；只输入 `/` 回车会列出全部命令。

| 命令 | 说明 |
|------|------|
| `/connect` | 交互式配置向导（8 家供应商选择 + 连接测试） |
| `/provider list/save/switch/remove` | 多 Provider 管理（故障转移时自动切换） |
| `/session list/switch/new/rename/remove` | 多会话管理（独立历史 / checkpoint / 压缩状态） |
| `/task status/steps/reset` | 任务级 checkpoint 查看与管理 |
| `/window status/set <n>` | 滚动窗口设置（超过阈值自动压缩） |
| `/index` | 扫描项目生成文件/函数/导入/导出索引 |
| `/ask <问题>` | 基于项目索引的 LLM 代码问答 |
| `/compact` | 手动压缩上下文（保留最近 N 轮） |
| `/distill` | 经验蒸馏，把历史挖掘成技能库 |
| `/dream` | 记忆整理 + 清理过期日志 |
| `/skill [list \| <name> \| reload]` | 查看 / 刷新技能库 |
| `/tools` | 查看所有可用工具 |
| `/help` | 显示帮助 |
| `/exit` / `/quit` | 退出 |

## 功能特性

### 1. 四层记忆系统

| 层级 | 文件 | 用途 |
|------|------|------|
| L1 | `checkpoint.md` | 当前会话检查点，启动自动恢复 |
| L2 | `MEMORY.md` | 跨会话项目记忆，自动注入 System Prompt |
| L3 | `notes.md` | 临时笔记 / 待办 / 调试记录 |
| L4 | `history.json` | 完整对话历史（可检索） |

### 2. 任务级 Checkpoint（v2.0 新增）

- 每次工具调用自动写入 `task-checkpoint.json`
- 包含：目标 / 当前步骤 / 已修改文件 / 阻塞问题 / 时间戳
- `/task status` 查看当前进度，`/task steps` 查看每步详情
- 启动自动恢复，崩溃可续

### 3. 多会话管理（v2.0 新增）

```bash
/session list            # 查看所有会话
/session switch <id>     # 切换会话
/session new <名称>      # 创建新会话
/session rename <id> <新名称>
/session remove <id>
```

每个会话独立的 `history.json`、`checkpoint.md`、`task-checkpoint.json`、`compress-state.json`，储存在 `sessions/<id>/` 下。

### 4. 多 Provider 故障转移（v1.2 新增）

支持配置多组 API Key，主 Provider 失败时自动切换：

| 错误类型 | 策略 |
|----------|------|
| 401 / Key 失效 | 立即切换到下一个 |
| 429 / 速率限制 | 冷却 30s 后切换 |
| 5xx / 超时 | 指数退避重试 3 次后切换 |

```bash
# 配置多个 Provider（在 .env 中）
API_KEY=sk-mimo-xxx
API_KEY_1=sk-openai-xxx
API_KEY_2=sk-anthropic-xxx
```

### 5. 分层摘要压缩（三档触发）

- **软阈值 60%** — 仅日志告警
- **标准阈值 80%** — 早期原文压缩为 L0 摘要，保留最近 5 轮
- **紧急阈值 95%** — 旧摘要与更早原文合并升层，保留最近 3 轮
- 压缩状态持久化到 `compress-state.json`，重启不丢
- **滚动窗口（v2.0 新增）**：超过 `maxRawTurns`（默认 20 轮）自动压缩，保持对话新鲜度

### 6. 按模型自动识别上下文窗口

内置 13 个主流模型映射（MiMo 1M / GLM-4 128K / Moonshot 128K / DeepSeek 64K / GPT-4o 128K / Claude 200K / 硅基流动等）。启动时若未设置 `MAX_TOKEN` 会自动按模型设置。

> LLM 报错 `context_length_exceeded` / `prompt too long` 时，CLI 会自动降级 `maxTokens`（×0.9）并强制压缩后重试一次。

### 7. 工具调用系统

- **内置工具**：`readFile` / `writeFile` / `runShell` / `git`
- **MCP 风格外部工具**：把 `mcp-tools.json` 或 `mcp-tools/*.json` 放进项目根目录即可自动加载
- **危险命令拦截**：白名单模式，仅允许常见开发命令
- **操作审计**：所有工具调用记录到 `audit.log`
- **路径安全**：禁止 `../` 路径逃逸，写文件自动 `mkdir -p`

### 8. 技能库系统

- `skill-lib.md` 用 Markdown 声明技能
- 输入匹配：CJK 单字 + ASCII 词 + 停用词过滤
- 每次对话 top-2 命中技能自动注入 System Prompt
- `/distill` 自动从历史对话挖掘新技能

### 9. 项目索引与问答（v2.0 新增）

```bash
/index          # 扫描 ts/js/json/md 文件，提取函数/导入/导出
/ask <问题>     # 基于索引结果，调用 LLM 回答代码相关问题
```

- 索引文件：`.mi-cc-index.json`
- 支持基于关键词的代码检索（TF-IDF 打分）
- 索引命中后注入 System Prompt，提升代码问答准确性

### 10. MCP Server 模式

mi-cc 可作为 MCP Server 被任意支持 MCP 协议的客户端调用：

```bash
# 启动 MCP Server（stdio 模式）
mi-cc --mcp
```

**OpenClaw 配置示例**：

```json
{
  "mcpServers": {
    "mi-cc": {
      "command": "mi-cc",
      "args": ["--mcp"],
      "env": { "API_KEY": "your_key" }
    }
  }
}
```

**暴露的能力**：

| 类型 | 名称 | 描述 |
|------|------|------|
| tool | `agent_execute` | 执行完整编程任务（内部自主规划、工具调用、压缩） |
| tool | `readFile` / `writeFile` / `runShell` / `git` | 原子工具调用 |
| tool | `skill_match` | 根据输入匹配相关技能 |
| resource | `memory://project` | 项目记忆 |
| resource | `memory://notes` | 临时笔记 |
| resource | `memory://checkpoint` | 会话检查点 |

### 11. 彩色终端 UI（v2.0 新增）

- 工具调用结果：彩色边框 + 状态图标（✓ / ✗）
- 助手回复：蓝色标题 + 分隔线
- 警告 / 成功 / 错误：黄色 / 绿色 / 红色
- 进度条：20 格进度显示

## 项目结构

```
.
├── mimo-cli.ts            # 主程序入口（初始化 + REPL）
├── mcp-mode.ts            # MCP Server 模式入口
├── commands.ts            # 斜杠命令（12+ 个命令）
├── compress.ts            # 分层摘要压缩 + 滚动窗口
├── memory.ts              # 四层记忆 + 会话管理
├── tools.ts               # 内置工具 + 危险命令拦截 + 审计日志
├── skills.ts              # 技能库匹配与蒸馏
├── mcp.ts                 # MCP 风格外部工具加载
├── types.ts               # 共享类型定义
├── bin/mi-cc.js           # CLI 启动器
├── src/
│   ├── state.ts           # AppState 单例（会话/配置/消息管理）
│   ├── llm.ts             # LLM Provider 接口
│   ├── llm-core.ts        # LLM 调用核心（超时/错误处理/压缩上下文）
│   ├── agent.ts           # Agent 循环 + 工具调用处理
│   ├── cli.ts             # REPL 交互 + Tab 补全
│   ├── router.ts          # ProviderRouter 故障转移
│   ├── config.ts          # Zod Schema 配置校验
│   ├── ui.ts              # chalk 彩色渲染
│   └── indexer.ts         # 项目索引与问答
├── __tests__/
│   ├── compress.test.ts   # 压缩测试
│   ├── tools.test.ts      # 安全函数测试
│   └── skills.test.ts     # 技能匹配测试
├── docs/
│   ├── plan.md            # 优化升级计划
│   ├── features.md        # 功能改进详细设计
│   └── mcp-guide.md       # MCP Server 接入指南
├── sessions/              # 多会话存储（每个子目录是一个会话）
├── skill-lib.md           # 技能库
├── mcp-tools.example.json # MCP 外部工具示例
├── .env.example           # 环境变量示例
├── tsconfig.json          # strict TypeScript 配置
├── package.json           # v2.0.0
├── index.html             # 项目官网
└── README.md
```

## 安全说明

- 工具调用结果会作为 `role: 'tool'` 消息传回 LLM（带 `tool_call_id` 配对）
- `runShell` 内部统一走 `child_process.exec` + 白名单过滤 + 操作审计
- 写文件自动 `mkdir -p` 父目录，禁止路径逃逸
- `.env` 已加入 `.gitignore`，API Key 不会泄露
- 可选加密存储（安装 keytar 后自动启用），否则明文 `.env` 回退

## 开发

```bash
# 类型检查（strict 模式）
npx tsc --noEmit

# 启动开发模式（tsx 自动重载）
npm run dev

# 运行测试
npm test

# 构建
npm run build
```

## License

MIT
