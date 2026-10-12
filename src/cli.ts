#!/usr/bin/env node
/**
 * ddboard — CLI for the DD-Board differential-diagnosis protocol.
 *
 * Commands (plan §3/§4):
 *   init      create the .ddboard/session.json skeleton in the current project
 *   validate  check a session file against the zod schema + protocol invariants
 *   render    project a session into the static board.md / board.html
 *   mcp       run the MCP server over stdio (what an MCP host spawns)
 *
 * Plain node:util argv handling on purpose — no CLI framework.
 */

import { readFileSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { renderDiagnosisBoard } from "./board.js";
import {
  formatSessionIssues,
  loadSessionFromFile,
  saveSessionToFile,
  SESSION_FILE,
} from "./session.js";
import { main as serveMcp } from "./server.js";

const USAGE = `ddboard — 鉴别诊断协议 CLI：先验证根因假设，再动手修 Bug

用法:
  ddboard init                 在当前目录创建 .ddboard/session.json 会话模板，并打印 MCP 配置片段
  ddboard validate <file>      校验会话文件（字段定义 + INV-1 治疗授权门 + INV-2 降级规则）
  ddboard render [file]        渲染静态诊断板 board.md / board.html 到当前目录（默认 .ddboard/session.json）
  ddboard mcp                  以 stdio 启动 MCP server（供 coding agent 的 host 拉起）
  ddboard --version, -v        打印版本
  ddboard --help, -h           打印本帮助

会话文件 .ddboard/session.json 是单一事实源：纯 JSON、git 友好。协议全文见 protocol/SPEC.md。`;

function packageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function verdictTally(hypotheses: { verdict: string }[]): string {
  const count = (verdict: string) => hypotheses.filter((h) => h.verdict === verdict).length;
  return `${count("confirmed")} confirmed / ${count("refuted")} refuted / ${count("downgraded-guess")} downgraded-guess / ${count("untested")} untested`;
}

// ---------------------------------------------------------------------------
// init — session skeleton + MCP config snippet (SPEC §8)
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const file = path.resolve(SESSION_FILE);
  try {
    await access(file);
    fail(
      [
        `已存在会话文件：${file}`,
        "会话文件是单一事实源，init 不会覆盖它。",
        "重开诊断：删除该文件后重新 init，或直接在 coding agent 里用 start_session 重置。",
      ].join("\n"),
    );
  } catch {
    // ENOENT — 没有会话，继续创建
  }
  await saveSessionToFile(file, {
    bug: { title: "", repro: "" },
    hypotheses: [],
    treatmentAuthorizedAt: null,
  });
  console.log(
    [
      `已创建会话模板：${file}`,
      "",
      "下一步：",
      "  1. 把下面的 MCP 配置片段粘进 coding agent host 的配置文件后重启会话：",
      "",
      "    {",
      '      "mcpServers": {',
      '        "dd-board": {',
      '          "command": "npx",',
      '          "args": ["-y", "dd-board", "mcp"]',
      "        }",
      "      }",
      "    }",
      "",
      "    配置文件位置 — Claude Code：项目级 .mcp.json，或 ~/.claude.json 根级 mcpServers；",
      "                  Cline：~/.cline/data/settings/cline_mcp_settings.json",
      "  2. 抛一个真实 bug 给 agent：协议会强制它先 propose_hypotheses（≥2 条假设、各绑区分性探针），",
      "     逐条 record_probe_result，绑不出探针的假设自动降级 downgraded-guess，",
      "     全部判定后 request_treatment 才会放行。",
      "  3. ddboard render  —  渲染静态诊断板 board.md / board.html 核对留痕。",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// validate — schema + INV-1 / INV-2 at the boundary
// ---------------------------------------------------------------------------

async function validate(file: string): Promise<void> {
  let session;
  try {
    session = await loadSessionFromFile(file);
  } catch (error) {
    if (error instanceof ZodError) {
      fail(`${file} 校验失败（协议不变式被破坏）：\n${formatSessionIssues(error)}`);
    }
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(
    [
      `OK: ${file} 通过协议校验`,
      `- bug: ${session.bug.title || "（标题待填）"}`,
      `- 假设: ${session.hypotheses.length} 条（${verdictTally(session.hypotheses)}）`,
      `- 治疗授权: ${session.treatmentAuthorizedAt ?? "未授权"}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// render — static board projection
// ---------------------------------------------------------------------------

async function render(file: string | undefined): Promise<void> {
  const sessionFile = file ?? SESSION_FILE;
  const session = await loadSessionFromFile(sessionFile);
  const { markdown, html } = renderDiagnosisBoard(session);
  await Promise.all([writeFile("board.md", markdown, "utf8"), writeFile("board.html", html, "utf8")]);
  console.log(
    [
      `已渲染诊断板（来自 ${sessionFile}）：`,
      "- board.md",
      "- board.html",
      `共 ${session.hypotheses.length} 条假设（${verdictTally(session.hypotheses)}）。打开 board.html 核对假设卡与排除留痕。`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// argv dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.version) {
    console.log(packageVersion());
    return;
  }

  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  switch (command) {
    case "init":
      return init();
    case "validate":
      if (rest[0] === undefined) {
        fail(`用法: ddboard validate <file>\n例: ddboard validate .ddboard/session.json`);
      }
      return validate(rest[0]);
    case "render":
      return render(rest[0]);
    case "mcp":
      return serveMcp();
    default:
      fail(`未知命令：${command}\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
