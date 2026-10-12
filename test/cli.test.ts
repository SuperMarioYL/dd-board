import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 与其他用例相同约定：先 npm run build，再 node --test。
// CLI 用例通过 spawn dist/cli.js 走真实 bin 入口（package.json 的 ddboard bin 指向它）。
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(CLI));
const EXAMPLE = path.join(REPO_ROOT, "examples", "session.example.json");

const execFileAsync = promisify(execFile);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run the CLI in an explicit cwd; a non-zero exit is captured, not thrown. */
async function runCli(args: string[], cwd = REPO_ROOT): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

test("--version prints the package version", async () => {
  const { stdout, code } = await runCli(["--version"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "0.1.0");
});

test("validate accepts the shipped example session", async () => {
  const { stdout, code } = await runCli(["validate", EXAMPLE]);
  assert.equal(code, 0);
  assert.match(stdout, /OK/);
  assert.match(stdout, /3 条/);
});

test("validate exits non-zero and prints the zod issues for an invalid session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ddboard-cli-test-"));
  try {
    // INV-2 违例：unprobeable 假设没有标记 downgraded-guess
    const bad = {
      bug: { title: "x", repro: "y" },
      hypotheses: [
        { id: "h-1", statement: "s", probe: null, status: "unprobeable", verdict: "untested", result: null },
      ],
      treatmentAuthorizedAt: null,
    };
    const file = path.join(dir, "bad.json");
    await writeFile(file, JSON.stringify(bad));
    const { stderr, code } = await runCli(["validate", file]);
    assert.equal(code, 1);
    assert.match(stderr, /校验失败/);
    assert.match(stderr, /downgraded-guess/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("render writes board.md and board.html into the working directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ddboard-cli-test-"));
  try {
    const { code } = await runCli(["render", EXAMPLE], dir);
    assert.equal(code, 0);
    const markdown = await readFile(path.join(dir, "board.md"), "utf8");
    const html = await readFile(path.join(dir, "board.html"), "utf8");
    assert.match(markdown, /诊断板/);
    assert.match(markdown, /h-1|商品详情页/);
    assert.match(html, /DD-Board 诊断板/);
    assert.match(html, /downgraded-guess/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
