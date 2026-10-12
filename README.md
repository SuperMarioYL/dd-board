[English](./README.en.md) | **简体中文**

<div align="center">
  <img src="https://readme-typing-svg.demolab.com/?font=JetBrains+Mono&weight=700&size=24&pause=1000&color=2EA043&center=true&vCenter=true&random=false&width=760&height=120&lines=Diagnose+before+you+treat.;hypothesis+%E2%86%92+probe+%E2%86%92+verdict+%E2%86%92+treatment;No+fix+without+a+verified+root+cause." alt="DD-Board — 先诊断后治疗">
  <h1>DD-Board</h1>
  <p><strong>强制 Coding Agent 先验证根因假设、再动手修 Bug 的鉴别诊断协议层</strong></p>
  <p>
    <a href="https://github.com/SuperMarioYL/dd-board/actions/workflows/ci.yml"><img src="https://github.com/SuperMarioYL/dd-board/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/dd-board"><img src="https://img.shields.io/npm/v/dd-board" alt="npm version"></a>
    <img src="https://img.shields.io/node/v/dd-board" alt="node version">
    <img src="https://img.shields.io/badge/MCP-compatible-2EA043" alt="MCP compatible">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
  </p>
</div>

---

Coding Agent 修 Bug 最贵的浪费，是 Agent 从不确立根因就连环试错、烧完预算回到起点。DD-Board 用鉴别诊断协议强制 Agent 先诊断后治疗：动手修复前必须给出 top-N 根因假设，每个假设绑定一条最廉价的**区分性探针**（一条结果可机器判定的命令或测试），先跑探针拿到 verdict，再申请治疗授权；跑不出探针的假设自动降级为「未验证猜测」。协议引擎模型无关——你自带 agent，DD-Board 只持有协议状态机、治疗授权门与静态诊断板。

## 为什么需要 DD-Board

主流 Agent 循环把「诊断」和「治疗」合并成一个隐式动作：上下文里分不清哪句是猜测、哪句是已验证事实，后续修复全部建立在未验证前提上。prompt 里写一句「先诊断」是**约定**，不是**强制**——模型可以忘、可以绕。DD-Board 把这一步放进 MCP 工具层，协议直接拒绝违规操作：

| 没有 DD-Board | 有 DD-Board |
| --- | --- |
| 接到 Bug 直接改代码，改一版跑一遍失败再改一版 | 动手修复前必须 `propose_hypotheses` 提交至少 2 条相互竞争的根因假设（top-N 默认 N=3） |
| 修复依据是「我觉得大概率是」 | 每个假设绑定一条**最廉价的区分性探针**，先跑探针再治疗 |
| 猜测与事实在上下文里无法区分 | 绑不出探针的假设自动降级 `downgraded-guess`——猜测显式留痕，不冒充事实 |
| 有假设没验证也照样动手 | 治疗授权门：`request_treatment` 直接拒绝并返回 untested 缺口清单 |
| 排除过程散落在对话里，无法复盘 | 会话文件即审计留痕（判定级 + 证据级），`ddboard render` 产出静态诊断板 |

核心原语是「假设 ⇄ 区分性探针的强制绑定 + 未验证降级语义 + 治疗授权门」，协议全文见 [protocol/SPEC.md](./protocol/SPEC.md)。

## 工作原理

两个进程，无服务、无数据库：

```text
┌────────────────────────────┐  MCP   ┌──────────────────────────────────┐
│ coding agent（用户自带）   │ ─────→ │ dd-board server（单 Node 进程）  │
│ Claude Code / Cline 等     │ ←───── │ 5 tools：start_session /         │
└────────────────────────────┘        │ propose_hypotheses /             │
                                      │ record_probe_result /            │
      用户 ──→ ddboard CLI            │ downgrade_hypothesis /           │
      init / validate / render        │ request_treatment（治疗授权门）  │
                                      └────────────────────┬─────────────┘
                                            读写           │
                                     .ddboard/session.json（单一事实源，git 友好）
                                                           │ render
                                           board.md / board.html 静态诊断板
```

**五个 MCP 工具**：

| 工具 | 作用 |
| --- | --- |
| `start_session` | 创建诊断会话，登记 bug 标题与复现方式 |
| `propose_hypotheses` | 提交 top-N 根因假设（协议最少 2 条），各绑一条区分性探针 `probe{cmd, expect}` |
| `record_probe_result` | 落盘探针判定与证据：verdict + `exitCode` / `durationMs` / 时间戳 / 可选输出片段 |
| `downgrade_hypothesis` | 把绑不出（或跑不出）探针的假设显式降级为未验证猜测 |
| `request_treatment` | **治疗授权门**：存在 untested 活假设时拒绝并返回缺口清单 |

**两条协议不变式**（由 zod schema 在会话读写边界强制）：

- **INV-1 治疗授权门**：`treatmentAuthorizedAt` 非 null 时，每个非降级假设的 verdict 必须属于 {confirmed, refuted}——存在 untested 假设，治疗请求就被拒绝。
- **INV-2 显式降级**：unprobeable 假设必须标记 `downgraded-guess`，不允许留在上下文里冒充已验证事实。

## 快速开始

前置：Node.js >= 22；任意支持 MCP 的 coding agent host（Claude Code、Cline 等）。从安装到第一张诊断板，目标 10 分钟以内。

### 1. 安装

```bash
npm i -g dd-board
# 或免安装直跑：npx -y dd-board <命令>
```

### 2. 初始化会话

```bash
cd your-project
ddboard init
```

生成 `.ddboard/session.json` 会话模板（单一事实源，纯 JSON、git 友好）并打印 MCP 配置片段。

### 3. 接入你的 coding agent

把 init 打印的片段粘进所在 host 的 MCP 配置文件，重启会话：

| Host | MCP 配置文件 |
| --- | --- |
| Claude Code | 项目级 `.mcp.json`，或 `~/.claude.json` 根级 `mcpServers` |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` |

```json
{
  "mcpServers": {
    "dd-board": {
      "command": "npx",
      "args": ["-y", "dd-board", "mcp"]
    }
  }
}
```

### 4. 抛一个真实 bug 给 agent

协议会强制 agent 自主走完全流程，你只需等待：`propose_hypotheses`（≥2 条假设、各绑探针）→ `record_probe_result`（逐条判定）→ 绑不出探针的假设自动降级 → `request_treatment`（有 untested 假设就被拒并返回缺口清单）→ 授权后才动手修复。

### 5. 渲染诊断板

```bash
ddboard render        # 读 .ddboard/session.json，产出 board.md / board.html
```

打开 `board.html` 核对假设卡与排除留痕——根因是「验证出来的」，不是「猜出来的」。

### 先看一张诊断板（不需要 agent）

```bash
git clone https://github.com/SuperMarioYL/dd-board.git && cd dd-board
npx -y dd-board validate examples/session.example.json
npx -y dd-board render examples/session.example.json   # 在当前目录产出 board.md / board.html
```

`examples/session.example.json` 是一个完整的示例会话（合成 bug）：2 条可探针假设已判定、1 条绑不出探针已降级、治疗已授权。

## 演示

完整流程 transcript（init → propose → probe → 治疗授权门拒绝 → render）：[assets/demo-script.md](./assets/demo-script.md)，终端录制脚本（vhs）见 [assets/demo.tape](./assets/demo.tape)。

核心一幕——假设还没验证，agent 抢跑治疗，授权门当场拒绝并点名缺口：

```text
agent → dd-board: request_treatment { summary: "直接改缓存翻新顺序，先发版" }
dd-board → agent:
治疗授权被拒绝（INV-1）：存在 2 条 untested 假设——h-1、h-2
先对每条假设 record_probe_result 拿到 confirmed/refuted，绑不出探针的用 downgrade_hypothesis 降级，再重新申请治疗。
```

补齐判定后重新申请，授权放行；`ddboard render` 的诊断板上，被排除的分支与降级猜测完整留痕（示例 bug 为合成数据，完整分镜见 demo-script.md）。

## 能力与接口

CLI（`ddboard`）：

| 命令 | 作用 |
| --- | --- |
| `ddboard init` | 创建 `.ddboard/session.json` 会话模板并打印 MCP 配置片段 |
| `ddboard validate <file>` | 按 schema + INV-1/INV-2 校验会话文件，失败时逐条打印 zod issues 并以非零码退出 |
| `ddboard render [file]` | 渲染静态诊断板 `board.md` / `board.html` 到当前目录 |
| `ddboard mcp` | 以 stdio 启动 MCP server（供 host 拉起） |

会话文件是单一事实源，字段与协议语义由 [protocol/SPEC.md](./protocol/SPEC.md) 定义（zod 权威实现在 `src/schema.ts`）：

```jsonc
{
  "bug": { "title": "...", "repro": "..." },
  "hypotheses": [
    {
      "id": "h-1",
      "statement": "根因假设陈述",
      "probe": { "cmd": "最廉价的机器可判定命令", "expect": "exit code 0" },
      "status": "probeable",
      "verdict": "confirmed",
      "result": { "exitCode": 0, "durationMs": 42, "at": "2026-10-12T08:00:00.000Z" }
    }
  ],
  "treatmentAuthorizedAt": null
}
```

「可审计留痕」的口径为**判定级 + 证据级**：每个跑过的探针落盘 verdict 与 result（exitCode、durationMs、时间戳、可选输出片段）。完整示例见 [examples/session.example.json](./examples/session.example.json)。

当前边界（v0.1）：只渲染静态文件，没有实时 Web 看板；不做自动根因分析、不内置任何模型——协议引擎模型无关，agent 由你自带；探针由 agent 在 host 侧执行并回报结果。

## 配置

没有配置文件——约定优于配置：

- 会话文件固定在项目根的 `.ddboard/session.json`；MCP server 以 host 的启动目录为项目根。
- `ddboard render` 把 `board.md` / `board.html` 写到当前目录。
- 探针判定语义：`expect` 为 `exit code N` 时按退出码判定，否则按输出片段包含判定（SPEC §4）。
- 运行时要求 Node.js >= 22。

## Roadmap

**已实现（0.1.0）**

- 鉴别诊断协议 SPEC 定稿 + zod 会话 schema（INV-1/INV-2）
- MCP server 五工具 + 治疗授权门
- CLI `init` / `validate` / `render` 与静态诊断板 board.md / board.html

**计划中（可能调整）**

- 更多 MCP host 的开箱接入；探针执行（runProbe）内置为服务端可选模式
- 严重度门控：N 次失败或烧掉 $X 后才强制协议，小 bug 不过度诊断
- 企业版：诊断留痕审计导出、多仓库聚合、SSO、私有 harness 集成

## 付费与私有化

DD-Board 面向按 token 付账、跑长时自主修 Bug 的商业工程团队：

- **自托管开源**：MIT 开源，跑在你自己的机器与 CI 里，会话文件不出境。
- **企业私有化版（年订阅）**：面向信创与私有化部署团队，提供诊断留痕审计导出、多仓库聚合、SSO 与私有 harness 集成。设计伙伴（前 3 家）¥30k–50k/年；正式定价 ¥80k/年/团队。
- **不做云 SaaS**：诊断板必须活在开发回路里，而「数据不出境」的团队恰恰不接受托管——这也是企业版只做私有化交付的原因。

商务意向请提 [GitHub Issues](https://github.com/SuperMarioYL/dd-board/issues)。

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
