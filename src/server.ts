/**
 * DD-Board MCP server — the differential-diagnosis protocol engine.
 *
 * A pure protocol state machine: no LLM calls, no network, no root-cause
 * analysis. Five tools drive the session lifecycle of protocol/SPEC.md §3:
 *
 *   start_session → propose_hypotheses → record_probe_result / downgrade_hypothesis → request_treatment
 *
 * The treatment gate (request_treatment) refuses with the untested-hypothesis
 * gap list while any hypothesis still has verdict "untested" (INV-1), and
 * unprobeable hypotheses must be downgraded before the gate opens (INV-2).
 *
 * .ddboard/session.json is the single source of truth. Every read goes through
 * parseSession (invariants enforced at the boundary) and every write is
 * re-validated before persisting. The file path resolves against the server's
 * working directory, so an MCP host spawning the server in a project root gets
 * that project's session.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import {
  parseSession,
  ProbeResultSchema,
  ProbeSchema,
  type DiagnosisSession,
  type Hypothesis,
  type Probe,
  type ProbeResult,
} from "./schema.js";

const SESSION_FILE = path.join(".ddboard", "session.json");

/** One tool result carrying a plain text payload for the agent. */
function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Session file — single source of truth
// ---------------------------------------------------------------------------

function sessionFilePath(): string {
  return path.join(process.cwd(), SESSION_FILE);
}

/**
 * Load the session, enforcing the schema and both invariants (INV-1, INV-2) at
 * the boundary. Domain errors carry actionable guidance for the agent.
 */
async function loadSession(): Promise<DiagnosisSession> {
  let raw: string;
  try {
    raw = await readFile(sessionFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`没有活动会话：先调用 start_session 创建 ${SESSION_FILE}`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${SESSION_FILE} 不是合法 JSON——会话文件是单一事实源，请修复后重试或从 git 历史回溯`,
    );
  }
  try {
    return parseSession(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((issue) => `- ${issue.path.join(".") || "session"}: ${issue.message}`)
        .join("\n");
      throw new Error(`${SESSION_FILE} 校验失败（协议不变式被破坏）：\n${issues}`);
    }
    throw error;
  }
}

/** Validate against the zod schema before every persist, then write atomically-shaped JSON. */
async function saveSession(session: DiagnosisSession): Promise<void> {
  parseSession(session);
  const file = sessionFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Probe judging — protocol/SPEC.md §4
// ---------------------------------------------------------------------------

/**
 * Judge a probe result against its expectation:
 * - expect "exit code N" → machine-judge by the probe's exit code;
 * - anything else → substring match against the recorded output snippet.
 * A match confirms the hypothesis; anything else refutes it.
 *
 * Exported so the CLI probe runner (src/probes.ts) reuses the exact rule
 * the server applies — the judging semantics have one authoritative home.
 */
export function judgeProbe(
  probe: Probe,
  result: ProbeResult,
): { verdict: "confirmed" | "refuted"; basis: string } {
  const exitCodeExpect = /^exit code (\d+)$/i.exec(probe.expect.trim());
  if (exitCodeExpect) {
    const matched = result.exitCode === Number(exitCodeExpect[1]);
    return {
      verdict: matched ? "confirmed" : "refuted",
      basis: `按退出码判定：exitCode ${result.exitCode} ${matched ? "==" : "!="} ${exitCodeExpect[1]}（expect "${probe.expect}"）`,
    };
  }
  const matched =
    result.outputSnippet !== undefined && result.outputSnippet.includes(probe.expect);
  return {
    verdict: matched ? "confirmed" : "refuted",
    basis: matched
      ? `输出片段包含 expect "${probe.expect}"`
      : `输出片段未包含（或未提供）expect "${probe.expect}"`,
  };
}

// ---------------------------------------------------------------------------
// Server — five tools per plan §3/§4
// ---------------------------------------------------------------------------

export function createDBoardServer(): McpServer {
  const server = new McpServer(
    { name: "dd-board", version: "0.1.0" },
    {
      instructions:
        "鉴别诊断协议：修 bug 前先 start_session 登记问题；propose_hypotheses 提交至少 2 条根因假设（top-N 默认 N=3）并各绑一条区分性探针；逐条 record_probe_result 取得 confirmed/refuted，绑不出探针的假设用 downgrade_hypothesis 降级为未验证猜测；全部判定后才能 request_treatment 申请治疗授权，动手修复。",
    },
  );

  server.registerTool(
    "start_session",
    {
      description:
        "创建诊断会话（.ddboard/session.json，已有会话会被重置）：登记 bug 标题与复现方式，进入鉴别诊断流程。",
      inputSchema: z.object({
        bug: z.object({
          title: z.string().describe("bug 标题"),
          repro: z.string().describe("复现方式"),
        }),
      }),
    },
    async ({ bug }) => {
      const createdAt = new Date().toISOString();
      await saveSession({ bug, hypotheses: [], treatmentAuthorizedAt: null });
      return textResult(
        [
          "会话已创建：.ddboard/session.json",
          `- session id: dd-${randomUUID().slice(0, 8)}（createdAt ${createdAt}）`,
          `- bug: ${bug.title}`,
          "- hypotheses: 0",
          "下一步：propose_hypotheses 提交至少 2 条根因假设（top-N 默认 N=3），每条绑定区分性探针 probe{cmd, expect}；绑不出探针的假设置 probe=null。",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "propose_hypotheses",
    {
      description:
        "提交根因假设并追加进会话（top-N 默认 N=3，协议最少 2 条）。每条含 id、statement 与区分性探针 probe{cmd, expect}；绑不出探针时 probe=null（unprobeable，自动降级为 downgraded-guess 留痕）。绑定探针的假设 verdict 为 untested，须先跑探针才能申请治疗授权。",
      inputSchema: z.object({
        hypotheses: z
          .array(
            z.object({
              id: z.string().describe("会话内唯一的假设 id，如 h-1"),
              statement: z.string().describe("根因假设陈述"),
              probe: ProbeSchema.nullable().describe("区分性探针；绑不出则 null"),
            }),
          )
          .describe("本轮提交的假设列表，最少 2 条"),
      }),
    },
    async ({ hypotheses }) => {
      const session = await loadSession();
      if (session.treatmentAuthorizedAt !== null) {
        throw new Error("会话已授权治疗，不能再追加假设——请新开 start_session 诊断下一个 bug");
      }
      if (hypotheses.length < 2) {
        throw new Error(
          `协议最少要求 2 条根因假设（top-N 默认 N=3），只收到 ${hypotheses.length} 条`,
        );
      }
      const knownIds = new Set(session.hypotheses.map((hypothesis) => hypothesis.id));
      for (const { id } of hypotheses) {
        if (knownIds.has(id)) {
          throw new Error(`假设 id 重复：${id}`);
        }
        knownIds.add(id);
      }
      const proposed: Hypothesis[] = hypotheses.map(({ id, statement, probe }) => ({
        id,
        statement,
        probe,
        // status 是 probe != null 的冗余反范式副本，写入时在此同步（SPEC §6）
        status: probe === null ? "unprobeable" : "probeable",
        // INV-2：unprobeable 假设落盘时必须已是 downgraded-guess——绑不出探针即自动
        // 降级为未验证猜测（plan §3「跑不出探针的假设自动标 downgraded-guess」），
        // 不允许以 untested 身份混入治疗授权门
        verdict: probe === null ? "downgraded-guess" : "untested",
        result: null,
      }));
      session.hypotheses.push(...proposed);
      await saveSession(session);
      const roster = proposed.map((hypothesis) =>
        hypothesis.probe
          ? `- [${hypothesis.id}] ${hypothesis.status} · untested — 探针: \`${hypothesis.probe.cmd}\`（expect: ${hypothesis.probe.expect}）`
          : `- [${hypothesis.id}] unprobeable · downgraded-guess（绑不出探针，已自动降级为未验证猜测）`,
      );
      return textResult(
        [
          `已提交 ${proposed.length} 条假设（会话共 ${session.hypotheses.length} 条）：`,
          ...roster,
          "下一步：record_probe_result 逐条落盘探针判定；unprobeable 假设用 downgrade_hypothesis 降级。",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "record_probe_result",
    {
      description:
        '记录某条 probeable 假设的探针运行结果并按协议判定 verdict：expect 形如 "exit code 0" 时按退出码判定，否则按 outputSnippet 是否包含 expect 判定；匹配为 confirmed，否则 refuted。以最新一次判定为准。',
      inputSchema: z.object({
        hypothesisId: z.string().describe("要判定的假设 id"),
        result: ProbeResultSchema.describe(
          "探针运行证据：exitCode、durationMs、at（ISO 时间戳）、可选 outputSnippet",
        ),
      }),
    },
    async ({ hypothesisId, result }) => {
      const session = await loadSession();
      const hypothesis = session.hypotheses.find((h) => h.id === hypothesisId);
      if (!hypothesis) {
        const known = session.hypotheses.map((h) => h.id).join("、") || "（无）";
        throw new Error(`假设不存在：${hypothesisId}（会话内现有：${known}）`);
      }
      if (hypothesis.probe === null) {
        throw new Error(
          `假设 ${hypothesisId} 是 unprobeable（无探针可跑），用 downgrade_hypothesis 降级，而不是记录探针结果`,
        );
      }
      const { verdict, basis } = judgeProbe(hypothesis.probe, result);
      hypothesis.verdict = verdict;
      hypothesis.result = result;
      await saveSession(session);
      const untested = session.hypotheses
        .filter((h) => h.verdict === "untested")
        .map((h) => h.id);
      return textResult(
        [
          `[${hypothesis.id}] verdict: ${verdict} — ${basis}`,
          `探针证据已落盘：exitCode ${result.exitCode} · ${result.durationMs}ms · ${result.at}`,
          untested.length === 0
            ? "所有假设均已判定，可以 request_treatment 申请治疗授权。"
            : `剩余 untested 假设 ${untested.length} 条：${untested.join("、")}`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "downgrade_hypothesis",
    {
      description:
        "把假设显式降级为 downgraded-guess（未验证猜测）：绑不出或跑不出探针的假设必须在治疗授权前降级。对已绑定 probe 的假设会解除绑定（probe=null、status=unprobeable）；对 propose 时即 unprobeable 的假设是幂等确认。已有 confirmed/refuted 判定的假设不能降级——判定是留痕。",
      inputSchema: z.object({
        hypothesisId: z.string().describe("要降级的假设 id"),
      }),
    },
    async ({ hypothesisId }) => {
      const session = await loadSession();
      const hypothesis = session.hypotheses.find((h) => h.id === hypothesisId);
      if (!hypothesis) {
        const known = session.hypotheses.map((h) => h.id).join("、") || "（无）";
        throw new Error(`假设不存在：${hypothesisId}（会话内现有：${known}）`);
      }
      if (hypothesis.verdict === "confirmed" || hypothesis.verdict === "refuted") {
        throw new Error(
          `假设 ${hypothesisId} 已有探针判定 ${hypothesis.verdict}，判定是留痕，不能降级`,
        );
      }
      hypothesis.verdict = "downgraded-guess";
      // SPEC §3.4：降级置 status=unprobeable；status 与 probe != null 必须同步（SPEC §6）
      hypothesis.status = "unprobeable";
      hypothesis.probe = null;
      await saveSession(session);
      return textResult(
        `[${hypothesis.id}] 已降级为 downgraded-guess（未验证猜测），不再参与治疗授权门检查。`,
      );
    },
  );

  server.registerTool(
    "request_treatment",
    {
      description:
        "治疗授权门：动手修复前必须申请授权。存在 untested 假设时拒绝并返回缺口清单；每个假设都已 confirmed/refuted（或 unprobeable 已降级）才写入 treatmentAuthorizedAt。",
      inputSchema: z.object({
        summary: z.string().describe("治疗摘要：打算如何修复、依据哪个已验证的根因"),
      }),
    },
    async ({ summary }) => {
      const session = await loadSession();
      if (session.treatmentAuthorizedAt !== null) {
        return textResult(`治疗已于 ${session.treatmentAuthorizedAt} 授权，无需重复申请。`);
      }
      if (session.hypotheses.length === 0) {
        throw new Error(
          "治疗授权被拒绝：会话中没有任何假设——协议要求先 propose_hypotheses（至少 2 条）再申请治疗",
        );
      }
      const untested = session.hypotheses.filter((h) => h.verdict === "untested");
      if (untested.length > 0) {
        // INV-1：拒绝并返回缺口清单（所有 untested 假设 id）
        throw new Error(
          [
            `治疗授权被拒绝（INV-1）：存在 ${untested.length} 条 untested 假设——${untested.map((h) => h.id).join("、")}`,
            "先对每条假设 record_probe_result 拿到 confirmed/refuted，绑不出探针的用 downgrade_hypothesis 降级，再重新申请治疗。",
          ].join("\n"),
        );
      }
      session.treatmentAuthorizedAt = new Date().toISOString();
      await saveSession(session);
      const count = (verdict: Hypothesis["verdict"]) =>
        session.hypotheses.filter((h) => h.verdict === verdict).length;
      const tallies = (["confirmed", "refuted", "downgraded-guess"] as const)
        .map((verdict) => `${count(verdict)} ${verdict}`)
        .join(" / ");
      return textResult(
        [
          `治疗已授权（treatmentAuthorizedAt ${session.treatmentAuthorizedAt}）。`,
          `会话共 ${session.hypotheses.length} 条假设：${tallies}`,
          `治疗摘要：${summary}`,
          "下一步：ddboard render 渲染诊断板，核对假设卡与排除留痕后再动手修复。",
        ].join("\n"),
      );
    },
  );

  return server;
}

/** Connect the protocol engine over stdio — the entry point an MCP host spawns. */
export async function main(): Promise<void> {
  await createDBoardServer().connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
