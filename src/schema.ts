import { z } from "zod";

/**
 * DD-Board session file — the single source of truth for one differential
 * diagnosis. Plain, git-friendly JSON on disk at .ddboard/session.json.
 *
 * Protocol invariants enforced here (formalized in protocol/SPEC.md):
 * - Treatment gate: treatmentAuthorizedAt must stay null while any hypothesis
 *   is untested; authorization requires every non-downgraded hypothesis to
 *   have a confirmed or refuted verdict.
 * - Downgrade rule: an unprobeable hypothesis must be explicitly marked
 *   "downgraded-guess" — guesses may not masquerade as verified facts.
 * - Hypothesis.status is a denormalized copy of `probe != null`. Writers
 *   (init / record_probe_result) keep it in sync; the explicit field wins.
 */

/** The cheapest machine-judgeable command that can confirm or refute a hypothesis. */
export const ProbeSchema = z.object({
  cmd: z.string(),
  expect: z.string(),
});

/**
 * Evidence recorded for one probe run — the verdict-level plus evidence-level
 * audit trail (exit code, duration, timestamp, optional output excerpt).
 */
export const ProbeResultSchema = z.object({
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  at: z.string().datetime({ offset: true }),
  outputSnippet: z.string().optional(),
});

export const HypothesisSchema = z.object({
  id: z.string(),
  statement: z.string(),
  probe: ProbeSchema.nullable(),
  status: z.enum(["probeable", "unprobeable"]),
  verdict: z.enum(["untested", "confirmed", "refuted", "downgraded-guess"]),
  result: ProbeResultSchema.nullable(),
});

export const DiagnosisSessionSchema = z
  .object({
    bug: z.object({
      title: z.string(),
      repro: z.string(),
    }),
    hypotheses: z.array(HypothesisSchema),
    treatmentAuthorizedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .superRefine((session, ctx) => {
    for (const [index, hypothesis] of session.hypotheses.entries()) {
      if (hypothesis.status === "unprobeable" && hypothesis.verdict !== "downgraded-guess") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hypotheses", index, "verdict"],
          message: `hypothesis "${hypothesis.id}": unprobeable hypotheses must be marked "downgraded-guess"`,
        });
      }
      if (session.treatmentAuthorizedAt !== null && hypothesis.verdict === "untested") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hypotheses", index, "verdict"],
          message: `hypothesis "${hypothesis.id}": treatment cannot be authorized while this hypothesis is untested`,
        });
      }
    }
  });

export type Probe = z.infer<typeof ProbeSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type DiagnosisSession = z.infer<typeof DiagnosisSessionSchema>;

/** Validate an untyped value (e.g. the parsed contents of .ddboard/session.json). */
export function parseSession(input: unknown): DiagnosisSession {
  return DiagnosisSessionSchema.parse(input);
}
