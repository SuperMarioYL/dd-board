/**
 * Probe runner — executes a hypothesis's discriminating probe (probe.cmd) as
 * a child process, records the evidence as a ProbeResult, and judges the
 * verdict with the protocol's single judging rule (judgeProbe, SPEC §4).
 *
 * The runner performs no network access of its own: the only side effects are
 * those of the user's own probe command. Probes are shell commands, so exit
 * codes and combined stdout/stderr are the machine-judgeable evidence.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { judgeProbe } from "./server.js";
import type { Probe, ProbeResult } from "./schema.js";

const execAsync = promisify(exec);

/** Hard wall-clock limit for one probe — a probe must be cheap by protocol. */
export const PROBE_TIMEOUT_MS = 30_000;

/** Cap the persisted output snippet so session files stay reviewable. */
const MAX_OUTPUT_CHARS = 4_000;

export interface ProbeRun {
  /** Evidence to persist via record_probe_result / saveSessionToFile. */
  result: ProbeResult;
  /** Protocol verdict judged by judgeProbe — never a model's opinion. */
  verdict: "confirmed" | "refuted";
  /** Human-readable judging basis (exit-code or substring match). */
  basis: string;
}

/**
 * Run one probe and judge it. Throws a clear error when the probe exceeds
 * timeoutMs (a timed-out probe records no verdict — the hypothesis stays
 * untested until a cheaper probe or a downgrade settles it).
 */
export async function runProbe(
  probe: Probe,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeRun> {
  const startedAt = Date.now();
  let exitCode: number;
  let output: string;
  try {
    const { stdout, stderr } = await execAsync(probe.cmd, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    exitCode = 0;
    output = stdout + stderr;
  } catch (error) {
    const err = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    if (err.killed) {
      throw new Error(
        `探针超时被终止（上限 ${timeoutMs}ms）：${probe.cmd} —— 探针必须是最廉价的机器可判定命令，请换更小的探针或降级该假设`,
      );
    }
    exitCode = typeof err.code === "number" ? err.code : 1;
    output = (err.stdout ?? "") + (err.stderr ?? "");
  }
  const durationMs = Math.max(0, Date.now() - startedAt);
  const snippet = output.trim();
  const result: ProbeResult = {
    exitCode,
    durationMs,
    at: new Date().toISOString(),
    ...(snippet.length > 0
      ? {
          outputSnippet:
            snippet.length > MAX_OUTPUT_CHARS
              ? `${snippet.slice(0, MAX_OUTPUT_CHARS)}\n…（输出片段已截断）`
              : snippet,
        }
      : {}),
  };
  const { verdict, basis } = judgeProbe(probe, result);
  return { result, verdict, basis };
}
