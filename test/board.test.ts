import assert from "node:assert/strict";
import test from "node:test";

// Runs against the compiled output (`npm run build` first): node --test
// discovers test/*.test.ts directly, so the import must resolve on disk.
import { renderDiagnosisBoard } from "../dist/board.js";
import { parseSession } from "../dist/schema.js";

const CONFIRMED_STATEMENT = "空购物车触发除零";
const REFUTED_STATEMENT = "缓存击穿导致空指针";

function exampleSession() {
  return parseSession({
    bug: {
      title: "checkout 500 on empty cart",
      repro: `curl -s localhost:3000/checkout | jq '.error // "<none>"'`,
    },
    hypotheses: [
      {
        id: "h-1",
        statement: CONFIRMED_STATEMENT,
        probe: { cmd: "npm test -- --run cart.empty", expect: "exit code 0" },
        status: "probeable",
        verdict: "confirmed",
        result: {
          exitCode: 0,
          durationMs: 42,
          at: "2026-10-12T08:00:00.000Z",
          outputSnippet: "1 passed",
        },
      },
      {
        id: "h-2",
        statement: REFUTED_STATEMENT,
        probe: { cmd: "grep -rn cache src/cart.ts", expect: "no match" },
        status: "probeable",
        verdict: "refuted",
        result: {
          exitCode: 1,
          durationMs: 17,
          at: "2026-10-12T08:01:00.000Z",
        },
      },
    ],
    treatmentAuthorizedAt: null,
  });
}

test("markdown board shows hypothesis cards, probe evidence and the exclusion trail", () => {
  const { markdown } = renderDiagnosisBoard(exampleSession());

  // confirmed hypothesis card: id, statement, probe cmd/expect, verdict, evidence
  for (const fragment of [
    "[h-1]",
    CONFIRMED_STATEMENT,
    "npm test -- --run cart.empty",
    "exit code 0",
    "confirmed",
    "退出码 0",
    "42ms",
  ]) {
    assert.ok(markdown.includes(fragment), `markdown should contain ${fragment}`);
  }

  // probe results table carries 命令、判定、耗时 for both runs
  const resultsIndex = markdown.indexOf("## 探针结果");
  assert.notEqual(resultsIndex, -1);
  const results = markdown.slice(resultsIndex, markdown.indexOf("## 排除分支留痕"));
  for (const fragment of ["grep -rn cache src/cart.ts", "refuted", "42ms", "17ms"]) {
    assert.ok(results.includes(fragment), `probe results table should contain ${fragment}`);
  }

  // refuted hypothesis is retained visibly in the exclusion trail
  const trailIndex = markdown.indexOf("## 排除分支留痕");
  assert.notEqual(trailIndex, -1);
  const trail = markdown.slice(trailIndex);
  for (const fragment of ["[h-2]", REFUTED_STATEMENT, "已排除", "17ms"]) {
    assert.ok(trail.includes(fragment), `exclusion trail should retain ${fragment}`);
  }

  // treatment gate state: not authorized
  assert.ok(markdown.includes("未授权"), "gate should read 未授权");
});

test("html board is static and script-free", () => {
  const { html } = renderDiagnosisBoard(exampleSession());

  assert.equal(html.toLowerCase().includes("<script"), false);
  assert.ok(html.includes("<style>"), "styles are inlined");

  // both hypotheses and their evidence survive the HTML projection
  for (const fragment of ["h-1", "h-2", CONFIRMED_STATEMENT, REFUTED_STATEMENT, "42ms", "refuted", "排除分支留痕", "未授权"]) {
    assert.ok(html.includes(fragment), `html board should contain ${fragment}`);
  }

  // dynamic text is escaped
  assert.ok(html.includes("&lt;none&gt;"), "angle brackets in the repro must be escaped");
  assert.ok(!html.includes("<none>"), "repro must not leak a raw tag");
});
