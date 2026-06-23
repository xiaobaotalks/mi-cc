# mi-cc

**v2.3.0 · 为发烧而生**

**AI 编程助手 · 终端对话 + 工具调用 + 四层记忆 + 多模型故障转移 + 联网 + 多模态 + MCP Server**

> 默认对接国产大模型（小米 MiMo），兼容任意 OpenAI Chat Completions 协议通道。
>
> **三大核心价值**：
> - 🧠 **本地编程助手**：无缝终端体验，超长对话自动压缩，任务断点续跑
> - 🌐 **MCP 服务端**：让 OpenClaw/Cursor/Claude 获得专属编程能力，自主规划完成完整任务
> - 🔗 **联网 + 多模态**：内置 webFetch 联网搜索，/image 命令支持图片理解

---

## 为什么选择 mi-cc？

| 对比维度 | mi-cc | 普通 MCP 工具 |
|----------|-------|---------------|
| 🧠 记忆系统 | 四层记忆（checkpoint/MEMORY/notes/history），启动自动恢复 | 无 |
| 🔄 模型切换 | 多 Provider 故障转移，401/429/5xx 自动切换 | 依赖宿主模型，无切换能力 |
| 📦 上下文压缩 | 分层摘要 + 滚动窗口，超长对话自动压缩 | 依赖宿主处理 |
| 🎯 任务执行 | `agent_execute` 自主规划 + 多轮工具调用完成完整任务 | 仅支持原子操作（读/写/执行） |
| 🌐 联网能力 | 内置 webFetch 工具，LLM 可自主抓取网页内容 | 无 |
| 🖼️ 多模态 | `/image` 命令添加图片，Vision 模型直接理解 | 无 |
| 📚 技能库 | `/distill` 经验蒸馏，自动挖掘工作流为技能 | 无 |
| 🔍 项目索引 | `/index` 扫描代码，`/ask` 语义问答 | 无 |
| 💾 状态持久化 | 任务级 checkpoint，崩溃可续 | 无 |

---

## 安装

```bash
git clone https://github.com/xiaobaotalks/mi-cc.git
cd mi-cc
npm install
npm link          # 启用全局 mi-cc 命令
```

安装完成后即可在任意目录使用 `mi-cc` 启动。

## 配置

首次运行 `mi-cc` 时会自动检测 API Key，输入 `/connect` 即可启动配置向导。

```bash
# 方式一：交互式配置向导（推荐）
mi-cc
# 然后输入 /connect

# 方式二：直接指定 API Key
mi-cc
# 然后输入 /connect <你的API Key>

# 方式三：手动创建 .env
cp .env.example .env
# 编辑 .env 填入 API_KEY
```

## 运行

```bash
# 方式一：直接启动
mi-cc

# 方式二：指定会话
mi-cc -s my-session-id

# 方式三：MCP Server 模式（供 OpenClaw / Cursor / Claude 使用）
mi-cc --mcp

# 版本管理
mi-cc version             # 查看当前版本
mi-cc update              # 一键检查并更新到最新版本
mi-cc update --force      # 强制 HTTP 模式更新（git 网络不佳时使用）
```

### 版本更新

mi-cc 启动时会自动检查 GitHub 上的最新版本。发现新版本时会提示：

```
┌──────────────────────────────────────────────────────────┐
│  📦 发现新版本 v2.3.0（当前 v2.2.1）                     │
│  运行 mi-cc update 即可一键更新                          │
└──────────────────────────────────────────────────────────┘
```

执行 `mi-cc update` 会自动：
1. 暂存本地修改（如有）
2. 拉取最新代码（`git pull`）
3. 更新依赖（`npm install`）
4. 恢复本地修改
5. 显示版本变化

> **网络不佳时**：如果 `git fetch` 失败，`mi-cc update` 会自动切换到 HTTP 模式，直接从 GitHub 下载最新文件。也可以手动执行 `mi-cc update --force` 强制使用 HTTP 模式。

> **旧版本无法更新时**：如果 `mi-cc update` 命令本身不生效（说明版本太旧），在项目目录执行以下 PowerShell 命令强制更新：
> ```powershell
> iwr https://raw.githubusercontent.com/xiaobaotalks/mi-cc/main/bin/mi-cc.js -OutFile bin/mi-cc.js; mi-cc update --force
> ```

---

## 快速体验：完整编程任务

```bash
# 启动 mi-cc
mi-cc

# 输入
帮我创建一个 Todo 应用的项目结构

# mi-cc 会自动：
# 1. 规划任务步骤
# 2. 创建目录结构
# 3. 生成 package.json
# 4. 创建核心源码文件
# 5. 运行 npm install
# 6. 验证构建

# 中途中断后再次启动，自动恢复进度
```

---

## 斜杠命令

输入 `/` 然后按 **Tab** 可补全命令；只输入 `/` 回车会列出全部命令。

| 命令 | 说明 |
|------|------|
| `/connect` | 交互式配置向导（8 家供应商选择 + 连接测试） |
| `/model [模型名\|list]` | 查看/快速切换模型 |
| `/provider list/save/switch/remove` | 多 Provider 管理（故障转移时自动切换） |
| `/image <路径> [提示]` | 添加图片并发送给 Vision 模型 |
| `/allow [命令名\|remove]` | 查看/管理命令授权白名单 |
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

---

## 功能特性

### 1. 四层记忆系统

| 层级 | 文件 | 用途 |
|------|------|------|
| L1 | `checkpoint.md` | 当前会话检查点，启动自动恢复 |
| L2 | `MEMORY.md` | 跨会话项目记忆，自动注入 System Prompt |
| L3 | `notes.md` | 临时笔记 / 待办 / 调试记录 |
| L4 | `history.json` | 完整对话历史（可检索） |

### 2. 任务级 Checkpoint

- 每次工具调用自动写入 `task-checkpoint.json`
- 包含：目标 / 当前步骤 / 已修改文件 / 阻塞问题 / 时间戳
- `/task status` 查看当前进度，`/task steps` 查看每步详情
- 启动自动恢复，崩溃可续

### 3. 多会话管理

每个会话独立的 `history.json`、`checkpoint.md`、`task-checkpoint.json`、`compress-state.json`，储存在 `sessions/<id>/` 下。

### 4. 多 Provider 故障转移

| 错误类型 | 策略 |
|----------|------|
| 401 / Key 失效 | 立即切换到下一个 |
| 429 / 速率限制 | 冷却 5min 后切换 |
| 5xx / 超时 | 指数退避重试 3 次后切换 |

### 5. 分层摘要压缩（三档触发）

- **软阈值 60%** — 仅日志告警
- **标准阈值 80%** — 早期原文压缩为 L0 摘要，保留最近 5 轮
- **紧急阈值 95%** — 旧摘要与更早原文合并升层，保留最近 3 轮
- **滚动窗口**：超过 `maxRawTurns`（默认 20 轮）自动压缩

### 6. 工具调用系统

- **内置工具**：`readFile` / `writeFile` / `runShell` / `git` / `webFetch`
- **危险命令拦截**：白名单模式 + 危险模式黑名单 + 路径逃逸拦截
- **交互式授权**：非白名单命令可手动授权（本次/永久）
- **操作审计**：所有工具调用记录到 `audit.log`
- **路径安全**：禁止 `../` 路径逃逸，禁止访问项目外文件
- **SSRF 防护**：webFetch 禁止访问内网/私有地址
- **写入限制**：writeFile 内容不超过 1MB

### 7. 联网能力

LLM 可通过 `webFetch` 工具自主抓取网页内容：
- 支持 HTTP/HTTPS 协议
- 自动清理 HTML 标签，格式化 JSON
- 重定向跟随（最多 5 次）+ 超时控制
- SSRF 防护（禁止访问内网地址）

### 8. 多模态支持

通过 `/image` 命令添加图片，Vision 模型可直接理解：
- 支持 PNG/JPG/GIF/WebP/BMP 格式
- 一步到位：`/image <路径> <提示>` 自动发送
- 图片以 base64 编码附加到消息中

### 9. 技能库系统

- `skill-lib.md` 用 Markdown 声明技能
- 输入匹配：CJK 单字 + ASCII 词 + 停用词过滤
- 每次对话 top-2 命中技能自动注入 System Prompt
- `/distill` 自动从历史对话挖掘新技能

### 10. 项目索引与问答

```bash
/index          # 扫描 ts/js/json/md 文件，提取函数/导入/导出
/ask <问题>     # 基于索引结果，调用 LLM 回答代码相关问题
```

---

## MCP Server 模式

mi-cc 作为 MCP Server 接入后，宿主 AI 助手获得以下专属能力：

```bash
mi-cc --mcp
```

### OpenClaw 配置

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

### 暴露的能力

| 类型 | 名称 | 描述 |
|------|------|------|
| tool | `agent_execute` | 执行完整编程任务（自主规划 + 多轮工具调用 + 压缩） |
| tool | `readFile` / `writeFile` | 文件读写 |
| tool | `runShell` | Shell 命令（超时 + 白名单拦截） |
| tool | `git` | Git 操作（子命令白名单 + --force 拦截） |
| tool | `webFetch` | 网页抓取（SSRF 防护 + 重定向限制） |
| tool | `skill_match` | 技能匹配 |
| resource | `memory://project` | 项目记忆（MEMORY.md） |
| resource | `memory://notes` | 临时笔记（notes.md） |
| resource | `memory://checkpoint` | 会话检查点 |

### 使用场景

```
用户: @mi-cc 帮我修复 src/utils.ts 中的类型错误

→ mi-cc 内部执行：
  1. readFile("src/utils.ts")     # 读取文件
  2. 分析错误                      # LLM 规划
  3. writeFile("src/utils.ts", ...) # 修复代码
  4. runShell("npx tsc --noEmit") # 验证
  返回执行结果摘要
```

---

## 项目结构

```
.
├── mi-cc.ts               # 主程序入口（初始化 + REPL）
├── mcp-mode.ts            # MCP Server 模式入口
├── commands.ts            # 斜杠命令（16+ 个命令）
├── compress.ts            # 分层摘要压缩 + 滚动窗口
├── memory.ts              # 四层记忆 + 会话管理
├── tools.ts               # 内置工具 + 安全拦截 + 审计日志 + 联网
├── skills.ts              # 技能库匹配与蒸馏
├── mcp.ts                 # MCP 风格外部工具加载
├── types.ts               # 共享类型定义
├── bin/mi-cc.js           # CLI 启动器
├── src/
│   ├── state.ts           # AppState 单例（会话/配置/消息管理）
│   ├── llm.ts             # LLM Provider 接口
│   ├── llm-core.ts        # LLM 调用核心（超时/错误处理/压缩上下文）
│   ├── agent.ts           # Agent 循环 + 工具调用 + 过程指示
│   ├── cli.ts             # REPL 交互 + Tab 补全 + 命令授权
│   ├── router.ts          # ProviderRouter 故障转移
│   ├── config.ts          # Zod Schema 配置校验 + API Key 占位符检测
│   ├── ui.ts              # chalk 彩色渲染 + 内容折叠
│   └── indexer.ts         # 项目索引与问答
├── __tests__/
│   ├── compress.test.ts   # 压缩测试
│   ├── tools.test.ts      # 安全函数测试
│   └── skills.test.ts     # 技能匹配测试
├── docs/
│   ├── plan.md            # 优化升级计划
│   ├── features.md        # 功能改进详细设计
│   └── mcp-guide.md       # MCP Server 接入指南
├── sessions/              # 多会话存储
├── skill-lib.md           # 技能库
├── mcp-tools.example.json # MCP 外部工具示例
├── .env.example           # 环境变量示例
├── tsconfig.json          # strict TypeScript 配置
└── package.json           # v2.3.0
```

---

## 安全说明

- 工具调用结果会作为 `role: 'tool'` 消息传回 LLM（带 `tool_call_id` 配对）
- `runShell` 内部统一走 `child_process.exec` + 白名单过滤 + 危险模式拦截 + 操作审计
- **路径安全**：禁止 `../` 路径逃逸，禁止访问项目外文件
- **SSRF 防护**：webFetch 禁止访问内网/私有地址（127.0.0.1、10.x、172.16-31.x、192.168.x、169.254.x）
- **写入限制**：writeFile 内容不超过 1MB，防止磁盘耗尽
- **Git 安全**：禁止 `git push --force` 和 `git reset --force`
- **Shell 解释器**：powershell/pwsh/cmd 不在白名单中，防止绕过安全检查
- **API Key 校验**：检测占位符和过短 Key（<16 字符），启动时告警
- **.env 合并写入**：切换 Provider 时保留备用 Provider 配置，不会清空
- `.env` 已加入 `.gitignore`，API Key 不会泄露
- 可选加密存储（安装 keytar 后自动启用），否则明文 `.env` 回退

## 开发

```bash
npx tsc --noEmit    # 类型检查
npm run dev         # 开发模式
npm test            # 运行测试
npm run build       # 构建
```

## License

MIT
