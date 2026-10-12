import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// 与 board.test.ts 相同约定：先 npm run build，再 node --test。
// 每个用例把编译产物 dist/server.js 作为真实 stdio MCP server 拉起，
// 用 SDK client 走完整协议（脚本化 MCP client demo，即 m2 里程碑的验收路径）。
const SERVER_ENTRY = fileURLToPath(new URL("../dist/server.js", import.meta.url));

const BUG = {
  title: "checkout 500 on empty cart",
  repro: "curl -s localhost:3000/checkout | jq '.error'",
};

type RawHypothesis = {
  id: string;
  statement: string;
  probe: unknown;
  status: string;
  verdict: string;
  result: Record<string, unknown> | null;
};
type RawSession = {
  bug: { title: string; repro: string };
  hypotheses: RawHypothesis[];
  treatmentAuthorizedAt: string | null;
};

/** Spawn dist/server.js in a temp cwd and run `run` against it as an MCP client. */
async function withServer(
  run: (client: Client, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ddboard-server-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: dir,
    stderr: "pipe",
  });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    serverStderr += String(chunk);
  });
  const client = new Client({ name: "dd-board-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    await run(client, dir);
  } catch (error) {
    if (serverStderr.trim() !== "") {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n— server stderr —\n${serverStderr}`);
    }
    throw error;
  } finally {
    try {
      await client.close();
    } catch {
      // 子进程可能已退出
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function readSession(dir: string): Promise<RawSession> {
  const raw = await readFile(path.join(dir, ".ddboard", "session.json"), "utf8");
  return JSON.parse(raw) as RawSession;
}

test("happy path: start → propose → record probes → treatment authorized", async () => {
  await withServer(async (client, dir) => {
    // exactly the five protocol tools
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "downgrade_hypothesis",
        "propose_hypotheses",
        "record_probe_result",
        "request_treatment",
        "start_session",
      ],
    );

    const started = await call(client, "start_session", { bug: BUG });
    assert.match(textOf(started), /会话已创建/);
    assert.match(textOf(started), /session id: dd-/);
    assert.match(textOf(started), /createdAt \d{4}-\d{2}-\d{2}T/);

    await call(client, "propose_hypotheses", {
      hypotheses: [
        {
          id: "h-1",
          statement: "空购物车触发除零",
          probe: { cmd: "npm test -- cart.empty", expect: "exit code 0" },
        },
        {
          id: "h-2",
          statement: "缓存击穿导致空指针",
          probe: { cmd: "grep -rn cache src/cart.ts", expect: "no cache module" },
        },
        {
          id: "h-3",
          statement: "风控规则误杀",
          probe: { cmd: "grep -rn risk src/cart.ts", expect: "exit code 1" },
        },
      ],
    });

    // 判定语义（SPEC §4）：h-1 退出码匹配 → confirmed；h-2 输出包含 expect → confirmed；h-3 退出码不匹配 → refuted
    const r1 = await call(client, "record_probe_result", {
      hypothesisId: "h-1",
      result: { exitCode: 0, durationMs: 42, at: "2026-10-12T08:00:00.000Z" },
    });
    assert.match(textOf(r1), /h-1] verdict: confirmed/);
    const r2 = await call(client, "record_probe_result", {
      hypothesisId: "h-2",
      result: {
        exitCode: 1,
        durationMs: 12,
        at: "2026-10-12T08:01:00.000Z",
        outputSnippet: "src/cart.ts: no cache module found",
      },
    });
    assert.match(textOf(r2), /h-2] verdict: confirmed/);
    const r3 = await call(client, "record_probe_result", {
      hypothesisId: "h-3",
      result: { exitCode: 0, durationMs: 8, at: "2026-10-12T08:02:00.000Z" },
    });
    assert.match(textOf(r3), /h-3] verdict: refuted/);

    const authorized = await call(client, "request_treatment", {
      summary: "修复除零：空购物车直接返回空结算页",
    });
    assert.notEqual(authorized.isError, true);
    assert.match(textOf(authorized), /治疗已授权/);

    // 会话文件是单一事实源：verdict、证据、授权时间全部落盘
    const session = await readSession(dir);
    assert.deepEqual(
      session.hypotheses.map((h) => [h.id, h.verdict, h.status]),
      [
        ["h-1", "confirmed", "probeable"],
        ["h-2", "confirmed", "probeable"],
        ["h-3", "refuted", "probeable"],
      ],
    );
    assert.deepEqual(session.hypotheses[0].result, {
      exitCode: 0,
      durationMs: 42,
      at: "2026-10-12T08:00:00.000Z",
    });
    assert.equal(session.bug.title, BUG.title);
    assert.ok(session.treatmentAuthorizedAt !== null);

    // 授权后再追加假设会被拒（否则会话文件将违反 INV-1）
    const afterAuth = await call(client, "propose_hypotheses", {
      hypotheses: [
        { id: "h-9", statement: "又一条", probe: null },
        { id: "h-10", statement: "再一条", probe: null },
      ],
    });
    assert.equal(afterAuth.isError, true);
    assert.match(textOf(afterAuth), /已授权/);
  });
});

test("treatment gate refuses while hypotheses are untested and names the gap list", async () => {
  await withServer(async (client, dir) => {
    await call(client, "start_session", { bug: BUG });
    await call(client, "propose_hypotheses", {
      hypotheses: [
        {
          id: "h-1",
          statement: "空购物车触发除零",
          probe: { cmd: "npm test -- cart.empty", expect: "exit code 0" },
        },
        {
          id: "h-2",
          statement: "缓存击穿导致空指针",
          probe: { cmd: "grep -rn cache src/cart.ts", expect: "exit code 0" },
        },
      ],
    });

    const refused = await call(client, "request_treatment", { summary: "直接改除零判断" });
    assert.equal(refused.isError, true);
    const refusal = textOf(refused);
    assert.match(refusal, /治疗授权被拒绝/);
    assert.match(refusal, /INV-1/);
    assert.match(refusal, /untested 假设——h-1、h-2/);

    // 授权未发生：treatmentAuthorizedAt 必须仍为 null（INV-1 的落盘约束）
    const session = await readSession(dir);
    assert.equal(session.treatmentAuthorizedAt, null);
  });
});

test("hypotheses without a runnable probe must be downgraded before treatment is authorized", async () => {
  await withServer(async (client, dir) => {
    await call(client, "start_session", { bug: BUG });
    await call(client, "propose_hypotheses", {
      hypotheses: [
        {
          id: "h-1",
          statement: "空购物车触发除零",
          probe: { cmd: "npm test -- cart.empty", expect: "exit code 0" },
        },
        { id: "h-2", statement: "上游网关抖动", probe: null },
      ],
    });

    // INV-2：绑不出探针的假设落盘即自动降级，不以 untested 身份混入治疗授权门
    const afterPropose = await readSession(dir);
    const h2AfterPropose = afterPropose.hypotheses.find((h) => h.id === "h-2");
    assert.ok(h2AfterPropose !== undefined);
    assert.equal(h2AfterPropose.verdict, "downgraded-guess");
    assert.equal(h2AfterPropose.status, "unprobeable");

    // 授权门此时仍被 h-1 挡住：缺口清单只点名未验证的 h-1，不含已降级的 h-2
    const refused = await call(client, "request_treatment", { summary: "先修除零" });
    assert.equal(refused.isError, true);
    const refusal = textOf(refused);
    assert.match(refusal, /untested 假设——h-1/);
    assert.doesNotMatch(refusal, /h-2/);

    // h-1 绑了探针但跑不出判定：显式降级后退出授权门检查
    const downgraded = await call(client, "downgrade_hypothesis", { hypothesisId: "h-1" });
    assert.match(textOf(downgraded), /h-1] 已降级为 downgraded-guess/);

    // 全部假设均已判定或显式降级：授权门放行（INV-1 允许全降级会话）
    const authorized = await call(client, "request_treatment", { summary: "修复除零" });
    assert.match(textOf(authorized), /治疗已授权/);

    // 降级留痕：probe 解除绑定，status 同步为 unprobeable（SPEC §3.4/§6）
    const session = await readSession(dir);
    const h1 = session.hypotheses.find((h) => h.id === "h-1");
    assert.ok(h1 !== undefined);
    assert.equal(h1.verdict, "downgraded-guess");
    assert.equal(h1.status, "unprobeable");
    assert.equal(h1.probe, null);
    assert.ok(session.treatmentAuthorizedAt !== null);
  });
});

test("protocol minimums and audit-trail guards reject with clear errors", async () => {
  await withServer(async (client) => {
    // 没有 start_session：一切工具都不可用
    const early = await call(client, "propose_hypotheses", {
      hypotheses: [
        { id: "h-1", statement: "a", probe: null },
        { id: "h-2", statement: "b", probe: null },
      ],
    });
    assert.equal(early.isError, true);
    assert.match(textOf(early), /start_session/);

    await call(client, "start_session", { bug: BUG });

    // 协议最少 2 条假设
    const tooFew = await call(client, "propose_hypotheses", {
      hypotheses: [{ id: "h-1", statement: "只有一条", probe: null }],
    });
    assert.equal(tooFew.isError, true);
    assert.match(textOf(tooFew), /最少要求 2 条/);

    await call(client, "propose_hypotheses", {
      hypotheses: [
        {
          id: "h-1",
          statement: "空购物车触发除零",
          probe: { cmd: "npm test -- cart.empty", expect: "exit code 0" },
        },
        { id: "h-2", statement: "上游网关抖动", probe: null },
      ],
    });

    // 假设 id 在会话内唯一
    const duplicate = await call(client, "propose_hypotheses", {
      hypotheses: [
        { id: "h-1", statement: "重复 id", probe: null },
        { id: "h-3", statement: "新假设", probe: null },
      ],
    });
    assert.equal(duplicate.isError, true);
    assert.match(textOf(duplicate), /假设 id 重复：h-1/);

    // 未知假设 id
    const unknown = await call(client, "record_probe_result", {
      hypothesisId: "h-9",
      result: { exitCode: 0, durationMs: 1, at: "2026-10-12T08:00:00.000Z" },
    });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /假设不存在：h-9/);

    // unprobeable 假设没有探针可跑，只能降级
    const onUnprobeable = await call(client, "record_probe_result", {
      hypothesisId: "h-2",
      result: { exitCode: 0, durationMs: 1, at: "2026-10-12T08:00:00.000Z" },
    });
    assert.equal(onUnprobeable.isError, true);
    assert.match(textOf(onUnprobeable), /unprobeable/);

    // 已有探针判定的假设不能降级——判定是留痕
    await call(client, "record_probe_result", {
      hypothesisId: "h-1",
      result: { exitCode: 0, durationMs: 42, at: "2026-10-12T08:00:00.000Z" },
    });
    const downgradeJudged = await call(client, "downgrade_hypothesis", { hypothesisId: "h-1" });
    assert.equal(downgradeJudged.isError, true);
    assert.match(textOf(downgradeJudged), /判定是留痕/);
  });
});
