**English** | [简体中文](./README.md)

<div align="center">
  <img src="https://readme-typing-svg.demolab.com/?font=JetBrains+Mono&weight=700&size=24&pause=1000&color=2EA043&center=true&vCenter=true&random=false&width=760&height=120&lines=Diagnose+before+you+treat.;hypothesis+%E2%86%92+probe+%E2%86%92+verdict+%E2%86%92+treatment;No+fix+without+a+verified+root+cause." alt="DD-Board — diagnose before you treat">
  <h1>DD-Board</h1>
  <p><strong>The differential-diagnosis protocol layer that forces coding agents to verify root causes before treatment</strong></p>
  <p>
    <a href="https://github.com/SuperMarioYL/dd-board/actions/workflows/ci.yml"><img src="https://github.com/SuperMarioYL/dd-board/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://www.npmjs.com/package/dd-board"><img src="https://img.shields.io/npm/v/dd-board" alt="npm version"></a>
    <img src="https://img.shields.io/node/v/dd-board" alt="node version">
    <img src="https://img.shields.io/badge/MCP-compatible-2EA043" alt="MCP compatible">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
  </p>
</div>

---

The most expensive waste in agent-driven bug fixing is an agent that never establishes a root cause and simply retries in circles until the budget burns out. DD-Board enforces diagnosis before treatment: before any fix, the agent must produce top-N competing root-cause hypotheses, each bound to the cheapest **discriminating probe** it can — a command or test whose outcome is machine-judgeable. Probes run first; only then is treatment authorized. A hypothesis that cannot carry a probe is automatically downgraded to an unverified guess. The protocol engine is model-agnostic — you bring the agent, DD-Board holds the protocol state machine, the treatment gate, and the static diagnosis board.

## Why DD-Board

Mainstream agent loops merge "diagnosis" and "treatment" into one implicit action: inside the context window there is no difference between a guess and a verified fact, so every fix is built on unverified premises. Writing "diagnose first" in a prompt is an **agreement**, not **enforcement** — the model can forget it or route around it. DD-Board moves that step into the MCP tool layer, where the protocol simply refuses violations:

| Without DD-Board | With DD-Board |
| --- | --- |
| The agent starts editing code immediately, then edit-run-fail loops | Before any fix it must call `propose_hypotheses` with at least 2 competing root-cause hypotheses (top-N, default N=3) |
| Fixes justified by "this is probably it" | Every hypothesis is bound to the **cheapest discriminating probe**; probes run before treatment |
| Guesses and facts are indistinguishable in context | A hypothesis without a runnable probe is auto-downgraded to `downgraded-guess` — the guess is on the record, never posing as fact |
| Untested hypotheses do not stop the fix | The treatment gate: `request_treatment` is refused with the untested gap list |
| The elimination trail is scattered across the conversation | The session file is the audit trail (verdict-level plus evidence-level); `ddboard render` produces a static diagnosis board |

The core primitive is "hypothesis ⇄ discriminating probe enforced binding + unverified-downgrade semantics + treatment authorization gate". The full protocol text lives in [protocol/SPEC.md](./protocol/SPEC.md).

## How it works

Two processes. No server, no database:

```text
┌─────────────────────────┐  MCP   ┌──────────────────────────────────────┐
│ coding agent (yours)    │ ─────→ │ dd-board server (single Node)        │
│ Claude Code, Cline, ... │ ←───── │ 5 tools: start_session /             │
└─────────────────────────┘        │   propose_hypotheses /               │
                                   │   record_probe_result /              │
    user ──→ ddboard CLI           │   downgrade_hypothesis /             │
   init / validate / render        │   request_treatment (treatment gate) │
                                   └──────────────────────┬───────────────┘
                                        read/write        │
                                    .ddboard/session.json (single source of truth)
                                                          │ render
                                         board.md / board.html (static board)
```

**The five MCP tools**:

| Tool | Purpose |
| --- | --- |
| `start_session` | Create a diagnosis session; register the bug title and reproduction |
| `propose_hypotheses` | Submit top-N root-cause hypotheses (minimum 2), each bound to a discriminating probe `probe{cmd, expect}` |
| `record_probe_result` | Persist the probe verdict and evidence: verdict + `exitCode` / `durationMs` / timestamp / optional output snippet |
| `downgrade_hypothesis` | Explicitly downgrade a hypothesis that has no runnable probe to an unverified guess |
| `request_treatment` | **The treatment authorization gate**: refused with the untested gap list while any live hypothesis is untested |

**Two protocol invariants** (enforced at the session-file boundary by the zod schema):

- **INV-1 treatment gate**: when `treatmentAuthorizedAt` is not null, every non-downgraded hypothesis must be confirmed or refuted — while any hypothesis is untested, treatment is refused.
- **INV-2 explicit downgrade**: an unprobeable hypothesis must be marked `downgraded-guess`; guesses may not masquerade as verified facts.

## Quickstart

Prerequisites: Node.js >= 22 and any MCP-capable coding agent host (Claude Code, Cline, etc). From install to your first diagnosis board in under 10 minutes.

### 1. Install

```bash
npm i -g dd-board
# or run without installing: npx -y dd-board <command>
```

### 2. Initialize a session

```bash
cd your-project
ddboard init
```

This creates the `.ddboard/session.json` session template (the single source of truth, plain JSON, git-friendly) and prints an MCP config snippet.

### 3. Wire in your coding agent

Paste the snippet into your host's MCP config file and restart the session:

| Host | MCP config file |
| --- | --- |
| Claude Code | project-level `.mcp.json`, or root-level `mcpServers` in `~/.claude.json` |
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

### 4. Hand the agent a real bug

The protocol forces the agent through the whole loop autonomously — you just wait: `propose_hypotheses` (at least 2 hypotheses, each with a probe) → `record_probe_result` (verdicts one by one) → hypotheses without a runnable probe are auto-downgraded → `request_treatment` (refused with the gap list while anything is untested) → only after authorization does the fix begin.

### 5. Render the board

```bash
ddboard render        # reads .ddboard/session.json, writes board.md / board.html
```

Open `board.html` and check the hypothesis cards and the elimination trail — the root cause was **verified**, not guessed.

### See a board first (no agent needed)

```bash
git clone https://github.com/SuperMarioYL/dd-board.git && cd dd-board
npx -y dd-board validate examples/session.example.json
npx -y dd-board render examples/session.example.json   # writes board.md / board.html into the cwd
```

`examples/session.example.json` is a complete example session (synthetic bug): 2 probeable hypotheses judged, 1 downgraded for having no probe, treatment authorized.

## Demo

A full walkthrough transcript (init → propose → probe → treatment-gate refusal → render): [assets/demo-script.md](./assets/demo-script.md). The terminal recording script (vhs) lives at [assets/demo.tape](./assets/demo.tape).

The key moment — the agent jumps to a fix while hypotheses are untested, and the gate refuses it on the spot, naming the gaps:

```text
agent → dd-board: request_treatment { summary: "just reorder the cache refresh and ship" }
dd-board → agent:
治疗授权被拒绝（INV-1）：存在 2 条 untested 假设——h-1、h-2
先对每条假设 record_probe_result 拿到 confirmed/refuted，绑不出探针的用 downgrade_hypothesis 降级，再重新申请治疗。
```

(The protocol's refusal text is in Chinese — it is addressed to the agent, and the gate speaks the language of the protocol engine.) Once the verdicts are in and treatment is re-requested, the gate opens; the rendered board keeps every refuted branch and downgraded guess on the record (the example bug is synthetic; see demo-script.md for the full storyboard).

## Capabilities and interfaces

CLI (`ddboard`):

| Command | Purpose |
| --- | --- |
| `ddboard init` | Create the `.ddboard/session.json` session template and print the MCP config snippet |
| `ddboard validate <file>` | Validate a session file against the schema + INV-1/INV-2; on failure prints each zod issue and exits non-zero |
| `ddboard render [file]` | Render the static board `board.md` / `board.html` into the current directory |
| `ddboard mcp` | Run the MCP server over stdio (what an MCP host spawns) |

The session file is the single source of truth; fields and semantics are defined by [protocol/SPEC.md](./protocol/SPEC.md) (authoritative zod implementation in `src/schema.ts`):

```jsonc
{
  "bug": { "title": "...", "repro": "..." },
  "hypotheses": [
    {
      "id": "h-1",
      "statement": "root-cause hypothesis statement",
      "probe": { "cmd": "cheapest machine-judgeable command", "expect": "exit code 0" },
      "status": "probeable",
      "verdict": "confirmed",
      "result": { "exitCode": 0, "durationMs": 42, "at": "2026-10-12T08:00:00.000Z" }
    }
  ],
  "treatmentAuthorizedAt": null
}
```

The audit trail is **verdict-level plus evidence-level**: every executed probe persists its verdict and result (exitCode, durationMs, timestamp, optional output snippet). A complete example ships at [examples/session.example.json](./examples/session.example.json).

Current boundaries (v0.1): static rendering only, no live web board; no automatic root-cause analysis and no built-in models — the protocol engine is model-agnostic and you bring the agent; probes are executed and reported by the agent on the host side.

## Configuration

There is no config file — convention over configuration:

- The session file lives at `.ddboard/session.json` in the project root; the MCP server treats the host's startup directory as the project root.
- `ddboard render` writes `board.md` / `board.html` into the current directory.
- Probe judging semantics: an `expect` of `exit code N` is judged by exit code, anything else by substring containment in the output snippet (SPEC §4).
- Requires Node.js >= 22.

## Roadmap

**Shipped (0.1.0)**

- Differential-diagnosis protocol SPEC + zod session schema (INV-1/INV-2)
- MCP server with the five tools and the treatment authorization gate
- CLI `init` / `validate` / `render` and the static board board.md / board.html

**Planned (subject to change)**

- Turnkey onboarding for more MCP hosts; probe execution (runProbe) as an optional server-side mode
- Severity gating: enforce the protocol only after N failures or $X of spend, so trivial bugs skip the ceremony
- Enterprise edition: audit export of diagnosis trails, multi-repo aggregation, SSO, private harness integration

## Pricing

DD-Board targets commercial engineering teams that run long autonomous bug-fixing agents and pay per token:

- **Self-hosted open source**: MIT-licensed, runs on your own machines and CI — session files never leave your perimeter.
- **Enterprise private deployment (annual subscription)**: for teams with localization / private-deployment constraints, adding audit export of diagnosis trails, multi-repo aggregation, SSO, and private harness integration. Design partners (first 3 teams) ¥30k–50k/year; list price ¥80k/year per team.
- **No cloud SaaS**: a diagnosis board must live inside the development loop, and teams that require data sovereignty will not accept hosting in the first place — which is why the enterprise edition is private deployment only.

For commercial inquiries, please open a [GitHub issue](https://github.com/SuperMarioYL/dd-board/issues).

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
