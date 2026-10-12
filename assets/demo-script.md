# DD-Board 演示脚本 — init → propose → probe → 治疗授权门拒绝 → render

本文件是 `assets/demo.tape`（vhs 录制脚本）的纯文本 fallback：vhs 不可用时（如 CI 环境）按此阅读演示流程，录制 `assets/demo.cast` 时也按此分镜。示例 bug 为合成数据；第 2–4 步是 MCP tool 调用，发生在 coding agent 会话内、无法在纯终端驱动，因此以工具调用 transcript 呈现（输出字符串与 `dist/server.js` 的实际返回一致）。

## 1. `ddboard init` — 生成会话模板与 MCP 配置片段

```console
$ ddboard init
已创建会话模板：/path/to/project/.ddboard/session.json

下一步：
  1. 把下面的 MCP 配置片段粘进 coding agent host 的配置文件后重启会话：

    {
      "mcpServers": {
        "dd-board": {
          "command": "npx",
          "args": ["-y", "dd-board", "mcp"]
        }
      }
    }

    配置文件位置 — Claude Code：项目级 .mcp.json，或 ~/.claude.json 根级 mcpServers；
                  Cline：~/.cline/data/settings/cline_mcp_settings.json
  2. 抛一个真实 bug 给 agent：协议会强制它先 propose_hypotheses（≥2 条假设、各绑区分性探针），
     逐条 record_probe_result，绑不出探针的假设自动降级 downgraded-guess，
     全部判定后 request_treatment 才会放行。
  3. ddboard render  —  渲染静态诊断板 board.md / board.html 核对留痕。
```

以下演示取合成 bug：「商品详情页偶发返回价格翻新前的旧价格」（示例会话见 `examples/session.example.json`）。

## 2. `propose_hypotheses` — 提交 top-N 假设并各绑一条区分性探针

```text
agent → dd-board: start_session { bug: { title: "商品详情页偶发返回价格翻新前的旧价格", repro: "..." } }
dd-board → agent:
会话已创建：.ddboard/session.json
- session id: dd-1a2b3c4d（createdAt 2026-10-12T08:39:12.000Z）
- bug: 商品详情页偶发返回价格翻新前的旧价格
- hypotheses: 0
下一步：propose_hypotheses 提交至少 2 条根因假设（top-N 默认 N=3），每条绑定区分性探针 probe{cmd, expect}；绑不出探针的假设置 probe=null。

agent → dd-board: propose_hypotheses { hypotheses: [
  { id: "h-1", statement: "缓存翻新采用「先删后写」，并发读在删除窗口命中旧副本",
    probe: { cmd: "node scripts/repro/price-cache-race.ts --iterations 200 --assert-refresh-order",
             expect: "stale price read during refresh" } },
  { id: "h-2", statement: "Redis 连接池耗尽导致详情接口回退到进程内旧缓存",
    probe: { cmd: "node scripts/repro/price-cache-redis-pool.ts --pool-size 1 --fail-on-fallback",
             expect: "exit code 0" } },
  { id: "h-3", statement: "上游价格服务在发布窗口写入了脏数据（上游访问日志已滚动过期，无法用一条廉价命令区分）",
    probe: null } ] }

dd-board → agent:
已提交 3 条假设（会话共 3 条）：
- [h-1] probeable · untested — 探针: `node scripts/repro/price-cache-race.ts --iterations 200 --assert-refresh-order`（expect: stale price read during refresh）
- [h-2] probeable · untested — 探针: `node scripts/repro/price-cache-redis-pool.ts --pool-size 1 --fail-on-fallback`（expect: exit code 0）
- [h-3] unprobeable · downgraded-guess（绑不出探针，已自动降级为未验证猜测）
下一步：record_probe_result 逐条落盘探针判定；unprobeable 假设用 downgrade_hypothesis 降级。
```

## 3. 抢跑治疗 — `request_treatment` 被授权门拒绝并返回缺口清单

假设还没验证，agent 就想动手改代码：

```text
agent → dd-board: request_treatment { summary: "直接改缓存翻新顺序，先发版" }
dd-board → agent:（工具调用报错，治疗未被授权）
治疗授权被拒绝（INV-1）：存在 2 条 untested 假设——h-1、h-2
先对每条假设 record_probe_result 拿到 confirmed/refuted，绑不出探针的用 downgrade_hypothesis 降级，再重新申请治疗。
```

## 4. `record_probe_result` — 逐条落盘探针 verdict 与耗时证据

```text
agent → dd-board: record_probe_result { hypothesisId: "h-1", result: { exitCode: 1, durationMs: 4123, at: "2026-10-12T08:41:07.000Z",
  outputSnippet: "AssertionError: expected refreshed price after delete, got stale price read during refresh (198/200 iterations)" } }
dd-board → agent:
[h-1] verdict: confirmed — 输出片段包含 expect "stale price read during refresh"
探针证据已落盘：exitCode 1 · 4123ms · 2026-10-12T08:41:07.000Z
剩余 untested 假设 1 条：h-2

agent → dd-board: record_probe_result { hypothesisId: "h-2", result: { exitCode: 1, durationMs: 2876, at: "2026-10-12T08:47:33.000Z",
  outputSnippet: "redis pool exhausted under load, but in-process fallback never triggered; 0/200 responses served from stale local cache" } }
dd-board → agent:
[h-2] verdict: refuted — 按退出码判定：exitCode 1 != 0（expect "exit code 0"）
探针证据已落盘：exitCode 1 · 2876ms · 2026-10-12T08:47:33.000Z
所有假设均已判定，可以 request_treatment 申请治疗授权。

agent → dd-board: request_treatment { summary: "修复翻新竞态：改为先写后删，避免删除窗口命中旧副本" }
dd-board → agent:
治疗已授权（treatmentAuthorizedAt 2026-10-12T09:05:12.000Z）。
会话共 3 条假设：1 confirmed / 1 refuted / 1 downgraded-guess
治疗摘要：修复翻新竞态：改为先写后删，避免删除窗口命中旧副本
下一步：ddboard render 渲染诊断板，核对假设卡与排除留痕后再动手修复。
```

## 5. `ddboard render` — 静态诊断板（假设卡、探针结果、排除留痕）

````console
$ ddboard render
已渲染诊断板（来自 .ddboard/session.json）：
- board.md
- board.html
共 3 条假设（1 confirmed / 1 refuted / 1 downgraded-guess / 0 untested）。打开 board.html 核对假设卡与排除留痕。

$ sed -n '1,40p' board.md
# 诊断板 — 商品详情页偶发返回价格翻新前的旧价格

> DD-Board 鉴别诊断留痕 · 由 .ddboard/session.json 渲染 · 会话文件即单一事实源

## Bug

**复现**:

```text
对同一商品并发触发价格翻新与详情读取：node scripts/repro/price-cache-race.ts --iterations 200，约 5% 的响应携带翻新前的缓存价格
```

## 治疗授权

- **状态**: 已授权（2026-10-12T09:05:12.000Z）

## 假设卡（共 3 条假设）

### [h-1] 缓存翻新采用「先删后写」，并发读在删除窗口命中旧副本

- **判定**: confirmed（已确认）
- **探针**: `node scripts/repro/price-cache-race.ts --iterations 200 --assert-refresh-order`
  - 期望判定: stale price read during refresh
- **探针结果**: 退出码 1 · 耗时 4123ms · 2026-10-12T08:41:07.000Z

### [h-2] Redis 连接池耗尽导致详情接口回退到进程内旧缓存

- **判定**: refuted（已排除）
- **探针**: `node scripts/repro/price-cache-redis-pool.ts --pool-size 1 --fail-on-fallback`
  - 期望判定: exit code 0
- **探针结果**: 退出码 1 · 耗时 2876ms · 2026-10-12T08:47:33.000Z

### [h-3] 上游价格服务在发布窗口写入了脏数据（上游访问日志已滚动过期，无法用一条廉价命令区分）

- **判定**: downgraded-guess（降级猜测）
````

被排除的 h-2 与降级的 h-3 完整保留在诊断板的「排除分支留痕」里——这就是会话文件作为审计留痕的可读投影。
