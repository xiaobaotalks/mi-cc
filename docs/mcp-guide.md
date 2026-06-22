# mi-cc MCP Server 接入指南

> 版本: 1.1.0  
> 日期: 2026-06-22  
> 适用: OpenClaw / Cursor / Claude Desktop / 任意 MCP 客户端

---

## 目录

1. [快速开始](#1-快速开始)
2. [配置方式](#2-配置方式)
3. [暴露的能力](#3-暴露的能力)
4. [使用示例](#4-使用示例)
5. [故障排查](#5-故障排查)

---

## 1. 快速开始

### 1.1 安装

```bash
# 方式一：npx 直接运行（推荐）
npx mimo-cli@latest --mcp

# 方式二：全局安装
npm install -g mimo-cli
mi-cc --mcp

# 方式三：本地安装
cd your-project
npm install --save-dev mimo-cli
npx mi-cc --mcp
```

### 1.2 环境变量

mi-cc MCP Server 通过环境变量读取配置：

```bash
export API_KEY=your_api_key_here
export BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
export MODEL=mimo-v2.5-pro
# 可选
export MAX_TOKEN=8000
```

### 1.3 验证启动

```bash
mi-cc --mcp
# 应输出 JSON-RPC 初始化消息，无报错
```

---

## 2. 配置方式

### 2.1 OpenClaw

在 `openclaw.json` 中添加：

```json
{
  "mcpServers": {
    "mi-cc": {
      "command": "npx",
      "args": ["-y", "mimo-cli@latest", "--mcp"],
      "env": {
        "API_KEY": "${env:MIMO_API_KEY}",
        "BASE_URL": "https://token-plan-cn.xiaomimimo.com/v1",
        "MODEL": "mimo-v2.5-pro"
      },
      "cwd": "${workspaceFolder}"
    }
  }
}
```

### 2.2 Cursor

在 Cursor Settings > MCP 中添加：

```json
{
  "mcpServers": {
    "mi-cc": {
      "command": "mi-cc",
      "args": ["--mcp"],
      "env": {
        "API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### 2.3 Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或对应路径：

```json
{
  "mcpServers": {
    "mi-cc": {
      "command": "/usr/local/bin/mi-cc",
      "args": ["--mcp"],
      "env": {
        "API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### 2.4 VS Code + GitHub Copilot

在 `.vscode/mcp.json` 中：

```json
{
  "servers": {
    "mi-cc": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mimo-cli@latest", "--mcp"],
      "env": {
        "API_KEY": "${env:MIMO_API_KEY}"
      }
    }
  }
}
```

---

## 3. 暴露的能力

### 3.1 Tools（工具）

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `agent_execute` | **执行完整编程任务**（内部自主规划、工具调用、压缩） | `{ "task": string }` |
| `readFile` | 读取文件内容 | `{ "path": string }` |
| `writeFile` | 写入文件内容 | `{ "path": string, "content": string }` |
| `runShell` | 执行 Shell 命令（带超时与危险命令拦截） | `{ "command": string, "timeout?": number }` |
| `git` | Git 操作 | `{ "operation": string, "params?": string[] }` |
| `skill_match` | 根据输入匹配相关技能 | `{ "query": string, "topN?": number }` |

### 3.2 Resources（资源）

| URI | 描述 | 内容 |
|-----|------|------|
| `memory://project` | 项目记忆（MEMORY.md） | Markdown 文本 |
| `memory://notes` | 临时笔记（notes.md） | Markdown 文本 |
| `memory://checkpoint` | 当前会话检查点 | JSON 文本 |

### 3.3 能力对比

| 使用方式 | 适用场景 | 能力完整性 |
|----------|----------|-----------|
| `agent_execute` | 复杂任务（"帮我重构这个项目"） | **完整**（含 Agent Loop、压缩、技能匹配） |
| 单工具调用 | 简单操作（"读这个文件"、"运行测试"） | 原子操作，无自主决策 |
| Resource 读取 | 了解项目背景 | 只读数据 |

---

## 4. 使用示例

### 4.1 方式一：agent_execute（推荐）

让 mi-cc 自主完成完整任务：

```
用户: @mi-cc 帮我修复 src/utils.ts 中的类型错误

→ 宿主调用 mi-cc/agent_execute
→ mi-cc 内部执行：
   1. readFile("src/utils.ts")
   2. 分析错误
   3. writeFile("src/utils.ts", fixedContent)
   4. runShell("npx tsc --noEmit") 验证
→ 返回执行结果摘要
```

### 4.2 方式二：单工具调用

宿主自己控制流程：

```
用户: 读取 src/config.ts

→ 宿主调用 mi-cc/readFile
→ 返回文件内容
→ 宿主 LLM 分析后决定下一步
```

### 4.3 方式三：Resource 读取

在对话开始时注入项目背景：

```
→ 宿主读取 mi-cc/memory://project
→ 将 MEMORY.md 内容注入 System Prompt
→ 后续对话中 LLM 了解项目架构
```

---

## 5. 故障排查

### 5.1 启动失败

```bash
# 检查 MCP SDK 是否安装
npm ls @modelcontextprotocol/sdk

# 手动测试启动
mi-cc --mcp
# 应看到 JSON-RPC 消息，无报错退出
```

### 5.2 工具调用无响应

- 检查环境变量 `API_KEY` 是否设置
- 检查 `BASE_URL` 是否可访问
- 查看 mi-cc 输出日志（如有）

### 5.3 agent_execute 返回空结果

- 确认 `task` 参数不为空
- 检查 LLM API 是否正常响应
- 可能是 token 超限导致压缩，等待时间较长

### 5.4 与 CLI 模式冲突

- MCP 模式与 CLI 模式**不能同时运行**在同一个目录
- 如果 CLI 正在运行，MCP 启动会创建新的 session

---

*文档版本: 2026-06-22*  
*问题反馈: https://github.com/xiaobaotalks/mi-cc/issues*
