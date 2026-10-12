# Changelog

## 0.1.0 — 2026-10-12

首个发布版本：鉴别诊断协议从 SPEC 到静态诊断板全链路打通。

### m1 — 协议定稿（lock_protocol_spec）

- `protocol/SPEC.md`：会话状态机、探针判定语义、unprobeable 降级规则、治疗授权条件。
- zod 会话 schema（`src/schema.ts`）：字段定义 + INV-1 治疗授权门 + INV-2 显式降级，读写边界强制。

### m2 — MCP 门（enforce_mcp_gates）

- MCP server 五个工具：`start_session` / `propose_hypotheses` / `record_probe_result` / `downgrade_hypothesis` / `request_treatment`。
- 治疗授权门：存在 untested 活假设时 `request_treatment` 被拒并返回缺口清单。

### m3 — 诊断板（render_diagnosis_board）

- CLI：`ddboard init`（会话模板 + MCP 配置片段）、`ddboard validate`（逐条 zod issues、非零码退出）、`ddboard render`（board.md / board.html 静态诊断板）、`ddboard mcp`（stdio server）。
- 探针 runner（`src/probes.ts`）：child_process 执行探针、超时守卫（30s）、复用协议判定规则。
- 示例会话 `examples/session.example.json` 通过 `ddboard validate`。
