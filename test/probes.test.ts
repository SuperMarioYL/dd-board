import assert from "node:assert/strict";
import test from "node:test";

// 与其他用例相同约定：先 npm run build，再 node --test。
import { PROBE_TIMEOUT_MS, runProbe } from "../dist/probes.js";
import { ProbeResultSchema } from "../dist/schema.js";

test("runProbe judges a matching probe as confirmed with persisted evidence", async () => {
  const run = await runProbe({ cmd: "echo probe evidence ready", expect: "probe evidence" });
  assert.equal(run.verdict, "confirmed");
  assert.match(run.basis, /输出片段包含 expect/);
  assert.equal(run.result.exitCode, 0);
  assert.ok(run.result.durationMs >= 0);
  assert.match(run.result.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(run.result.outputSnippet?.includes("probe evidence ready"));
  // 证据本身必须是可落盘的 ProbeResult（record_probe_result 的入参形状）
  assert.deepEqual(ProbeResultSchema.parse(run.result), run.result);
});

test("runProbe judges exit-code expectations and refutes mismatches", async () => {
  const confirmed = await runProbe({ cmd: "sh -c 'exit 3'", expect: "exit code 3" });
  assert.equal(confirmed.verdict, "confirmed");
  assert.equal(confirmed.result.exitCode, 3);
  assert.match(confirmed.basis, /exitCode 3 == 3/);

  // echo 以退出码 0 结束，与 "exit code 1" 不匹配 → refuted
  const refuted = await runProbe({ cmd: "echo nothing relevant", expect: "exit code 1" });
  assert.equal(refuted.verdict, "refuted");
  assert.equal(refuted.result.exitCode, 0);
});

test("non-zero probes still record their exit code instead of throwing", async () => {
  const run = await runProbe({ cmd: "sh -c 'echo boom >&2; exit 7'", expect: "exit code 0" });
  assert.equal(run.result.exitCode, 7);
  assert.ok(run.result.outputSnippet?.includes("boom"));
  assert.equal(run.verdict, "refuted");
});

test("a probe exceeding the timeout throws a clear error and records no verdict", async () => {
  assert.equal(PROBE_TIMEOUT_MS, 30_000);
  await assert.rejects(
    runProbe({ cmd: "sleep 5", expect: "exit code 0" }, 300),
    /探针超时被终止（上限 300ms）：sleep 5/,
  );
});
