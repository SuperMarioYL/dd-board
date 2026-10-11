/**
 * Static diagnosis-board renderer — the readable projection of a session file.
 *
 * Pure functions only: no filesystem, no network, no LLM, no clock. The CLI
 * (ddboard render) writes the returned strings to board.md / board.html.
 *
 * Board anatomy per protocol/SPEC.md §7:
 * - 假设卡: id, statement, probe cmd/expect, verdict
 * - 探针结果: 命令、判定、耗时 (cmd + verdict + result.durationMs)
 * - 排除分支留痕: refuted hypotheses retained visibly with full evidence
 * - 治疗授权: gate state (authorized at / untested gap list)
 */

import type { DiagnosisSession, Hypothesis } from "./schema.js";

/** The two static artifacts produced for one session. */
export interface RenderedBoard {
  markdown: string;
  html: string;
}

const VERDICT_LABELS: Record<Hypothesis["verdict"], string> = {
  untested: "未验证",
  confirmed: "已确认",
  refuted: "已排除",
  "downgraded-guess": "降级猜测",
};

const HTML_VERDICT_CLASS: Record<Hypothesis["verdict"], string> = {
  untested: "untested",
  confirmed: "confirmed",
  refuted: "refuted",
  "downgraded-guess": "downgraded",
};

/** Render one session into the markdown and HTML diagnosis boards. */
export function renderDiagnosisBoard(session: DiagnosisSession): RenderedBoard {
  return { markdown: renderMarkdown(session), html: renderHtml(session) };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(session: DiagnosisSession): string {
  const cards = session.hypotheses.map(hypothesisCardMd).join("\n\n");
  const sections = [
    `# 诊断板 — ${session.bug.title}`,
    "",
    "> DD-Board 鉴别诊断留痕 · 由 .ddboard/session.json 渲染 · 会话文件即单一事实源",
    "",
    "## Bug",
    "",
    `**复现**:`,
    "",
    "```text",
    session.bug.repro,
    "```",
    "",
    "## 治疗授权",
    "",
    treatmentMd(session),
    "",
    `## 假设卡（共 ${session.hypotheses.length} 条假设）`,
    "",
    cards,
    "",
    "## 探针结果",
    "",
    probeResultsMd(session),
    "",
    "## 排除分支留痕",
    "",
    refutedTrailMd(session),
    "",
  ];
  return sections.join("\n");
}

function verdictLabel(verdict: Hypothesis["verdict"]): string {
  return `${verdict}（${VERDICT_LABELS[verdict]}）`;
}

function formatDuration(durationMs: number): string {
  return `${durationMs}ms`;
}

/** Make a string safe inside a markdown table cell. */
function mdCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function hypothesisCardMd(hypothesis: Hypothesis): string {
  const lines = [
    `### [${hypothesis.id}] ${hypothesis.statement}`,
    "",
    `- **判定**: ${verdictLabel(hypothesis.verdict)}`,
  ];
  if (hypothesis.probe) {
    lines.push(
      `- **探针**: \`${mdCell(hypothesis.probe.cmd)}\``,
      `  - 期望判定: ${hypothesis.probe.expect}`,
    );
  } else {
    lines.push(`- **探针**: 无（unprobeable — 绑不出区分性探针）`);
  }
  if (hypothesis.result) {
    lines.push(
      `- **探针结果**: 退出码 ${hypothesis.result.exitCode} · 耗时 ${formatDuration(hypothesis.result.durationMs)} · ${hypothesis.result.at}`,
    );
    if (hypothesis.result.outputSnippet) {
      lines.push(
        "  - 输出片段:",
        "",
        "    ```",
        ...hypothesis.result.outputSnippet.split("\n").map((line) => `    ${line}`),
        "    ```",
      );
    }
  }
  return lines.join("\n");
}

function probeResultsMd(session: DiagnosisSession): string {
  const probed = session.hypotheses.flatMap((hypothesis) =>
    hypothesis.result ? [[hypothesis, hypothesis.result] as const] : [],
  );
  if (probed.length === 0) {
    return "（暂无已执行的探针）";
  }
  const rows = probed.map(([hypothesis, result]) => {
    const id = mdCell(hypothesis.id);
    const cmd = mdCell(hypothesis.probe?.cmd ?? "—");
    return `| [${id}] | \`${cmd}\` | ${verdictLabel(hypothesis.verdict)} | ${formatDuration(result.durationMs)} |`;
  });
  return [
    "| 假设 | 命令 | 判定 | 耗时 |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function refutedTrailMd(session: DiagnosisSession): string {
  const refuted = session.hypotheses.filter(
    (hypothesis) => hypothesis.verdict === "refuted",
  );
  if (refuted.length === 0) {
    return "（暂无被排除的分支）";
  }
  const trail = refuted.map((hypothesis) => hypothesisCardMd(hypothesis)).join("\n\n");
  return `以下假设已被探针排除，保留在此作为诊断留痕：\n\n${trail}`;
}

function treatmentMd(session: DiagnosisSession): string {
  if (session.treatmentAuthorizedAt !== null) {
    return `- **状态**: 已授权（${session.treatmentAuthorizedAt}）`;
  }
  const blocking = session.hypotheses.filter(
    (hypothesis) => hypothesis.verdict === "untested",
  );
  const lines = ["- **状态**: 未授权（治疗授权门未通过）"];
  if (blocking.length > 0) {
    lines.push(`- **缺口**: ${blocking.length} 个假设未验证：${blocking.map((h) => h.id).join("、")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(session: DiagnosisSession): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>DD-Board 诊断板 — ${escapeHtml(session.bug.title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f5f6f8; --fg: #1d2430; --muted: #5c6675; --card: #ffffff;
  --border: #d8dde5; --code-bg: #eceff3;
  --ok: #16794c; --ok-bg: rgba(22, 121, 76, 0.12);
  --bad: #b3261e; --bad-bg: rgba(179, 38, 30, 0.10);
  --warn: #8a5a00; --warn-bg: rgba(138, 90, 0, 0.12);
  --gray: #55606e; --gray-bg: rgba(85, 96, 110, 0.14);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151a21; --fg: #e6ebf2; --muted: #9aa5b4; --card: #1d242e;
    --border: #333c49; --code-bg: #262f3b;
    --ok: #5cd39a; --ok-bg: rgba(92, 211, 154, 0.14);
    --bad: #ff8a80; --bad-bg: rgba(255, 138, 128, 0.14);
    --warn: #ffcf70; --warn-bg: rgba(255, 207, 112, 0.14);
    --gray: #aab4c2; --gray-bg: rgba(170, 180, 194, 0.16);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--fg);
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.6;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.15rem; margin: 0 0 0.75rem; }
.muted { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.5rem; }
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  padding: 1rem 1.25rem; margin: 0 0 1rem;
}
.hypothesis.refuted, .hypothesis.downgraded { border-left: 4px solid var(--border); }
.hypothesis.confirmed { border-left: 4px solid var(--ok); }
.hypothesis.untested { border-left: 4px solid var(--warn); }
.badge {
  display: inline-block; border-radius: 999px; padding: 0.1rem 0.7rem;
  font-size: 0.85rem; font-weight: 600;
}
.badge.confirmed { color: var(--ok); background: var(--ok-bg); }
.badge.refuted { color: var(--bad); background: var(--bad-bg); }
.badge.untested { color: var(--warn); background: var(--warn-bg); }
.badge.downgraded { color: var(--gray); background: var(--gray-bg); }
pre {
  background: var(--code-bg); border-radius: 6px; padding: 0.75rem 1rem;
  overflow-x: auto; font-size: 0.9rem;
}
code {
  background: var(--code-bg); border-radius: 4px; padding: 0.1rem 0.35rem;
  font-size: 0.9em;
}
.field { margin: 0.25rem 0; }
.field .k { color: var(--muted); margin-right: 0.5rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
th, td { border: 1px solid var(--border); padding: 0.45rem 0.7rem; text-align: left; }
th { background: var(--code-bg); }
.trail-heading { margin: 1.25rem 0 0.5rem; font-size: 1rem; }
</style>
</head>
<body>
<main>
<h1>DD-Board 诊断板</h1>
<p class="muted">鉴别诊断留痕 · 由 .ddboard/session.json 渲染 · 会话文件即单一事实源</p>
${bugCardHtml(session)}
${treatmentCardHtml(session)}
<section>
  <h2>假设卡</h2>
  ${session.hypotheses.map(hypothesisCardHtml).join("\n  ")}
</section>
<section>
  <h2>探针结果</h2>
  ${probeResultsHtml(session)}
</section>
<section>
  <h2>排除分支留痕</h2>
  ${refutedTrailHtml(session)}
</section>
</main>
</body>
</html>
`;
}

function verdictBadgeHtml(verdict: Hypothesis["verdict"]): string {
  return `<span class="badge ${HTML_VERDICT_CLASS[verdict]}">${escapeHtml(verdict)} · ${VERDICT_LABELS[verdict]}</span>`;
}

function bugCardHtml(session: DiagnosisSession): string {
  return `<section class="card">
  <h2>Bug</h2>
  <p><strong>${escapeHtml(session.bug.title)}</strong></p>
  <pre>${escapeHtml(session.bug.repro)}</pre>
</section>`;
}

function treatmentCardHtml(session: DiagnosisSession): string {
  if (session.treatmentAuthorizedAt !== null) {
    return `<section class="card">
  <h2>治疗授权</h2>
  <p><span class="badge confirmed">已授权</span> <span class="muted">${escapeHtml(session.treatmentAuthorizedAt)}</span></p>
</section>`;
  }
  const blocking = session.hypotheses.filter(
    (hypothesis) => hypothesis.verdict === "untested",
  );
  const gap =
    blocking.length > 0
      ? `<p class="field"><span class="k">缺口</span> ${blocking.length} 个假设未验证：${blocking.map((h) => escapeHtml(h.id)).join("、")}</p>`
      : "";
  return `<section class="card">
  <h2>治疗授权</h2>
  <p><span class="badge untested">未授权</span> <span class="muted">治疗授权门未通过</span></p>
  ${gap}
</section>`;
}

function hypothesisCardHtml(hypothesis: Hypothesis): string {
  const probe = hypothesis.probe
    ? `<p class="field"><span class="k">探针</span><code>${escapeHtml(hypothesis.probe.cmd)}</code></p>
  <p class="field"><span class="k">期望判定</span>${escapeHtml(hypothesis.probe.expect)}</p>`
    : `<p class="field"><span class="k">探针</span><span class="muted">无（unprobeable — 绑不出区分性探针）</span></p>`;
  const result = hypothesis.result
    ? `<p class="field"><span class="k">探针结果</span>退出码 ${hypothesis.result.exitCode} · 耗时 ${formatDuration(hypothesis.result.durationMs)} · ${escapeHtml(hypothesis.result.at)}</p>${
        hypothesis.result.outputSnippet
          ? `\n  <pre>${escapeHtml(hypothesis.result.outputSnippet)}</pre>`
          : ""
      }`
    : "";
  return `<section class="card hypothesis ${HTML_VERDICT_CLASS[hypothesis.verdict]}">
  <h2>[${escapeHtml(hypothesis.id)}] ${escapeHtml(hypothesis.statement)}</h2>
  <p class="field"><span class="k">判定</span>${verdictBadgeHtml(hypothesis.verdict)}</p>
  ${probe}
  ${result}
</section>`;
}

function probeResultsHtml(session: DiagnosisSession): string {
  const probed = session.hypotheses.flatMap((hypothesis) =>
    hypothesis.result ? [[hypothesis, hypothesis.result] as const] : [],
  );
  if (probed.length === 0) {
    return `<p class="muted">暂无已执行的探针</p>`;
  }
  const rows = probed
    .map(
      ([hypothesis, result]) =>
        `  <tr><td>[${escapeHtml(hypothesis.id)}]</td><td><code>${escapeHtml(hypothesis.probe?.cmd ?? "—")}</code></td><td>${verdictBadgeHtml(hypothesis.verdict)}</td><td>${formatDuration(result.durationMs)}</td></tr>`,
    )
    .join("\n");
  return `<table>
  <thead><tr><th>假设</th><th>命令</th><th>判定</th><th>耗时</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function refutedTrailHtml(session: DiagnosisSession): string {
  const refuted = session.hypotheses.filter(
    (hypothesis) => hypothesis.verdict === "refuted",
  );
  if (refuted.length === 0) {
    return `<p class="muted">暂无被排除的分支</p>`;
  }
  return `<p class="muted">以下假设已被探针排除，保留在此作为诊断留痕：</p>\n${refuted
    .map(hypothesisCardHtml)
    .join("\n")}`;
}
