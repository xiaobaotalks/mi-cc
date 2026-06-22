# micli 优化升级计划

> 版本: 1.1.0-planned  
> 日期: 2026-06-22  
> 状态: 规划阶段

---

## 一、项目现状

micli 是一个终端智能编程助手，当前版本 1.0.0，核心能力包括：

- 终端对话 + LLM 工具调用（readFile / writeFile / runShell / git）
- 四层记忆系统（checkpoint / MEMORY / notes / history）
- 分层摘要压缩（60% / 80% / 95% 三档阈值）
- 技能库匹配与自动注入
- 斜杠命令 Tab 补全

### 当前技术债务

| 问题 | 影响 | 优先级 |
|------|------|--------|
| 6 个 `let` 全局变量手动同步 | 状态管理混乱，测试困难 | P1 |
| 强耦合 OpenAI SDK | 无法切换模型/供应商 | P1 |
| 无 LLM 超时/重试机制 | 网络波动时直接崩溃 | P1 |
| 危险命令黑名单不完整 | 安全风险 | P1 |
| 无单元测试 | 重构风险高 | P2 |
| System Prompt 全量重建 | 性能浪费 | P2 |
| 无 MCP Server 模式 | 生态接入受限 | P2 |

---

## 二、优化目标

### 2.1 短期目标（v1.1.0，1-2 周）

- [ ] MCP Server 模式（~83 行新增，零改动核心逻辑）
- [ ] 修复压缩状态恢复与摘要编号冲突
- [ ] LLM 超时重试与故障转移
- [ ] 文件路径白名单与审计日志
- [ ] `tsc --strict` 类型检查通过

### 2.2 中期目标（v1.2.0，3-4 周）

- [ ] AppState 状态管理重构
- [ ] LLM Provider 抽象层（支持多模型）
- [ ] ProviderRouter 多 Key 自动切换
- [ ] 配置 Schema 校验（zod）
- [ ] 单元测试覆盖核心函数

### 2.3 长期目标（v2.0.0，2-3 月）

- [ ] Loop 模式优化（Planner-Reviewer-Actor）
- [ ] 滚动窗口 + 增量摘要
- [ ] TUI 终端渲染（ink/chalk）
- [ ] 多会话管理
- [ ] 代码库 RAG 理解

---

## 三、阶段规划

### Phase 1: 稳定与接入（v1.1.0）

**时间**: 第 1-2 周  
**主题**: 修复关键缺陷 + MCP 生态接入

```
Week 1
├── Day 1-2: MCP Server 模式开发
│   ├── 新增 mcp-mode.ts（~80 行）
│   ├── mimo-cli.ts 入口加 --mcp 分支（+3 行）
│   ├── package.json 加 optionalDependencies
│   └── 测试：npx micli --mcp 可启动
├── Day 3-4: 压缩模块修复
│   ├── 修复 tieredCompact 摘要编号冲突
│   ├── 启动时加载 compress-state.json 恢复摘要层
│   └── 添加 tiktoken 真实 tokenizer（可选依赖）
└── Day 5: LLM 调用增强
    ├── callLLM() 添加 30s 超时（Promise.race + AbortController）
    ├── 指数退避重试（网络错误/5xx，最多 3 次）
    └── 错误分类：401/429/5xx/timeout/context_length

Week 2
├── Day 1-2: 安全加固
│   ├── runShell 白名单模式（默认只允许常见开发命令）
│   ├── 操作审计日志（audit.log）
│   └── 文件路径规范化 + 禁止 ../ 逃逸
├── Day 3-4: 类型与构建
│   ├── tsconfig.json strict: true
│   ├── 修复所有类型错误
│   └── 添加 build 脚本（tsc 编译到 dist/）
└── Day 5: 测试与文档
    ├── 单元测试：estimateTokens / tieredCompact / matchSkill / isDangerousCommand
    ├── 更新 README（MCP 接入方式）
    └── 发布 v1.1.0
```

### Phase 2: 架构重构（v1.2.0）

**时间**: 第 3-6 周  
**主题**: 解耦与扩展性

```
Week 3-4: 状态与配置重构
├── AppState 单例模式
│   ├── 封装 openai / config / history / tools / sessionId
│   ├── 提供 get/set/subscribe 接口
│   └── 去除所有全局 let 变量
├── Config 模块
│   ├── 单一入口 loadConfig()
│   ├── zod schema 校验
│   └── 默认值 < .env < 环境变量 < CLI 参数 的合并逻辑
└── 测试覆盖

Week 5-6: LLM Provider 抽象
├── LLMProvider 接口定义
│   ├── chat(params): Promise<LLMResponse>
│   ├── healthCheck(): Promise<boolean>
│   └── 统一 Message 类型（去除 OpenAI SDK 依赖）
├── OpenAIProvider 实现
├── MiMoProvider 实现（如有特殊接口）
├── ProviderRouter 故障转移
│   ├── 多组 API Key 配置支持
│   ├── 健康状态跟踪 + 冷却恢复
│   └── 自动切换 + 用户通知
└── 测试覆盖
```

### Phase 3: 智能增强（v2.0.0）

**时间**: 第 7-12 周  
**主题**: Agent 能力升级

```
Week 7-8: Loop 模式优化
├── Planner-Reviewer-Actor 架构
│   ├── Planner：轻量模型生成执行计划
│   ├── Actor：主模型执行单步工具调用
│   └── Reviewer：验证结果，决定是否继续
├── 任务级 Checkpoint
│   ├── 每步完成自动写入
│   ├── 崩溃后从 blockers 恢复
│   └── 任务进度追踪（currentStep/totalSteps）
└── 滚动窗口摘要
    ├── 固定保留 K 轮原文（如 20 轮）
    ├── 超窗内容自动摘要升层
    └── 摘要层只读，避免重写

Week 9-10: 终端体验
├── TUI 渲染（ink 或 chalk + cli-truncate）
│   ├── 工具调用独立面板/边框
│   ├── LLM 响应流式输出（打字机效果）
│   └── 进度条/Spinner
├── 多会话管理
│   ├── /session list / switch / rename
│   ├── 会话导出/导入（JSON）
│   └── 按时间/活跃度排序
└── 日志系统（pino）
    ├── 结构化日志 + 分级
    ├── 会话级日志文件
    └── --quiet / --verbose 模式

Week 11-12: 代码库理解
├── /index：扫描项目结构生成摘要
├── /ask：基于代码库 RAG 问答
│   ├── 文件索引（文件名 + 函数签名 + 注释）
│   ├── 向量检索（或简单 TF-IDF）
│   └── 注入相关代码片段到 Prompt
└── /refactor：结构化重构建议
```

---

## 四、里程碑

| 版本 | 时间 | 核心交付物 | 验收标准 |
|------|------|-----------|----------|
| v1.1.0 | 2 周后 | MCP Server + 压缩修复 + 超时重试 + 安全加固 | `micli --mcp` 可被 Cursor/OpenClaw 调用；`npm run test` 通过；`tsc --noEmit` 无错误 |
| v1.2.0 | 6 周后 | AppState + LLM Provider + ProviderRouter + 测试覆盖 | 支持 3+ 模型供应商；单元测试覆盖率 > 60%；零全局变量 |
| v2.0.0 | 3 月后 | Loop 优化 + TUI + 多会话 + 代码库 RAG | Planner-Reviewer 闭环；流式输出；多会话切换 < 1s |

---

## 五、风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| MCP SDK v2 不稳定 | 中 | MCP 功能需适配 | 锁定 v1.x 版本，v2 稳定后迁移 |
| tiktoken 增加包体积 | 低 | 安装变慢 | 作为可选依赖，无安装时 fallback 启发式估算 |
| strict TypeScript 改动量大 | 中 | 延期 | 分批次修复，先 `noImplicitAny` 再 `strictNullChecks` |
| TUI 引入 ink 增加复杂度 | 中 | 维护成本 | 先用 chalk 做彩色输出，ink 作为 v2.1 可选功能 |

---

## 六、参与方式

```bash
# 1. 克隆仓库
git clone https://github.com/xiaobaotalks/mi-cc.git
cd mi-cc

# 2. 安装依赖
npm install

# 3. 启动开发模式
npm run dev

# 4. 运行测试
npm test

# 5. 类型检查
npx tsc --noEmit
```

---

*文档版本: 2026-06-22*  
*维护者: micli 核心团队*
