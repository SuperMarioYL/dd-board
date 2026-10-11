# DD-Board 鉴别诊断协议 SPEC

- 版本：v0.1（m1 定稿）
- 状态：已定稿，可对外发布
- 字段权威实现：`src/schema.ts`（zod 定义是会话文件的唯一权威，本 SPEC 是其协议文本）
- 会话文件：`.ddboard/session.json` — 单一事实源，纯 JSON、git 友好
- 渲染产物：`board.md` / `board.html` 静态诊断板（`src/board.ts`）

## 1. 协议目标

Coding agent 修 Bug 最贵的浪费，是从不确立根因就连环试错。DD-Board 把诊断与治疗在协议层分开：

1. 动手修复前，agent 必须产出 top-N 个相互竞争的根因假设（默认 N=3，协议最少要求 2 条）；
2. 每个假设绑定一条最廉价的**区分性探针**——一条结果可机器判定的命令或测试；
3. 先跑探针拿到 verdict，再申请治疗授权；
4. 绑不出探针的假设被显式降级为「未验证猜测」（downgraded-guess），不允许混入事实叙述。

协议引擎模型无关：agent 由用户自带的 MCP host 提供（Claude Code、Cline 等），DD-Board 只持有会话状态机、治疗授权门与静态诊断板。

## 2. 会话文件字段定义

与 `src/schema.ts` 的 zod 定义一一对应，字段名、类型、可空性不得偏离。

### Probe — 区分性探针

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cmd` | `string` | 最廉价的机器可判定命令 |
| `expect` | `string` | 退出码或输出匹配，机器判定 |

### ProbeResult — 探针判定证据

由 `record_probe_result` 落盘，跑过探针才存在。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `exitCode` | `number`（整数） | 探针进程退出码 |
| `durationMs` | `number`（非负） | 探针耗时（毫秒），供诊断板渲染 |
| `at` | `string`（ISO 8601 datetime，含时区偏移） | 判定落盘时间戳 |
| `outputSnippet?` | `string`（可选） | 判定依据的输出片段 |

### Hypothesis — 根因假设

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 会话内唯一标识 |
| `statement` | `string` | 根因假设陈述 |
| `probe` | `Probe \| null` | 绑定的区分性探针；绑不出探针即为 unprobeable |
| `status` | `"probeable" \| "unprobeable"` | 可由 `probe != null` 推导的冗余反范式副本，以本显式字段为准（见 §6） |
| `verdict` | `"untested" \| "confirmed" \| "refuted" \| "downgraded-guess"` | 判定状态（见 §3 状态转移） |
| `result` | `ProbeResult \| null` | 跑过探针才有：判定 + 耗时 + 证据 |

### DiagnosisSession — 诊断会话

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bug` | `{ title: string, repro: string }` | 被诊断的 Bug 及其复现方式 |
| `hypotheses` | `Hypothesis[]` | top-N 根因假设，默认 N=3 |
| `treatmentAuthorizedAt` | `string`（ISO 8601 datetime，含时区偏移）`\| null` | 治疗授权时间；存在 untested 活假设时必为 `null` |

## 3. 会话生命周期

会话状态机由五个 MCP tools 驱动，顺序为：

```
start_session → propose_hypotheses → record_probe_result / downgrade_hypothesis → request_treatment
```

### 3.1 start_session

以 `bug.title` 与 `bug.repro` 创建会话：`hypotheses` 为空数组，`treatmentAuthorizedAt` 为 `null`。

### 3.2 propose_hypotheses

提交 top-N 根因假设（默认 N=3，协议最少要求 2 条）。每个假设必须绑定一条区分性探针（`cmd` + `expect`），或显式声明绑不出探针（`probe = null`，`status = "unprobeable"`）。未经探针验证前，所有假设 `verdict = "untested"`。

### 3.3 record_probe_result

对某个 `probeable` 假设执行其探针并落盘判定：按 §4 的判定语义得出 `confirmed` 或 `refuted`，同时写入 `ProbeResult`（`exitCode`、`durationMs`、`at`、可选 `outputSnippet`）。以最新一次判定为准。

### 3.4 downgrade_hypothesis

对绑不出探针的假设执行显式降级：`verdict` 置为 `"downgraded-guess"`，`status` 置为 `"unprobeable"`（`probe = null`）。降级后的假设退出治疗授权门检查，但保留在会话与诊断板中作为留痕。

### 3.5 request_treatment（治疗授权门）

授权前检查 INV-1（§5）：存在 untested 活假设时拒绝，并返回缺口清单（所有 `verdict = "untested"` 的假设 id）；检查通过则写入 `treatmentAuthorizedAt`。

### verdict 状态转移

```
untested ──record_probe_result──→ confirmed | refuted
unprobeable ──downgrade_hypothesis──→ downgraded-guess
```

## 4. 探针判定语义

探针执行由服务端以子进程运行 `probe.cmd`，按机器可判定规则得出 verdict：

- 执行结果满足 `probe.expect`（按退出码或输出匹配）→ `confirmed`；
- 否则 → `refuted`。

判定不依赖任何模型输出——探针的结论必须是机器可判定的。

## 5. 协议不变式

两条不变式由 `src/schema.ts` 在会话校验时强制（`parseSession` / `ddboard validate`）。

### INV-1 治疗授权门

`treatmentAuthorizedAt` 非 `null` 时，不存在 `verdict = "untested"` 的假设——即每个未降级假设的 verdict 必须属于 `{confirmed, refuted}`。存在未验证活假设时，治疗授权请求被拒绝并返回缺口清单。

### INV-2 unprobeable 显式降级

`status = "unprobeable"` 的假设必须显式标记为 `verdict = "downgraded-guess"`。猜测就是猜测：不允许留在上下文里冒充已验证事实。

## 6. status 字段权威规则

`Hypothesis.status` 完全可由 `probe != null` 推导，属冗余反范式字段：

- **以显式 `status` 字段为准**；
- 写入方（init / record_probe_result 等工具）在写会话时负责同步 `status` 与 `probe != null`；
- 消费方（诊断板、授权门）读取显式字段，不做二次推导。

## 7. 审计留痕定义

「可审计留痕」的口径为**判定级 + 证据级**两层：

- 判定级：每个假设的 `verdict`（`confirmed` / `refuted` / `downgraded-guess`）；
- 证据级：每个跑过的探针落盘 `result` —— `exitCode`、`durationMs`、时间戳 `at`、可选输出片段 `outputSnippet`。

会话文件是纯 JSON 且 git 友好，历史判定变更通过版本历史追溯。静态诊断板 `board.md` / `board.html` 是该留痕的可读投影：假设卡、探针结果（命令、判定、耗时）、被排除分支的完整留痕、治疗授权状态。

## 8. 接入 MCP host

`ddboard init` 生成 `.ddboard/session.json` 会话模板与 MCP 配置片段；把片段粘进所在 host 的 MCP 配置文件后重启会话：

| Host | MCP 配置文件 |
| --- | --- |
| Claude Code | 项目级 `.mcp.json`，或 `~/.claude.json` 根级 `mcpServers` |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` |

## 9. 校验

会话文件必须通过 zod 校验（字段定义 + INV-1 + INV-2）：

```
ddboard validate .ddboard/session.json
```

示例会话见 `examples/session.example.json`；校验失败时返回逐条 `addIssue` 错误（含假设 id 与违反的不变式）。
