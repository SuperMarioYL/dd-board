/**
 * Session file IO — .ddboard/session.json is the single source of truth for
 * one differential diagnosis. Every read and write goes through parseSession,
 * so the protocol invariants (INV-1 treatment gate, INV-2 downgrade rule) are
 * enforced at the file boundary, not just at the MCP tool boundary.
 *
 * The MCP server (src/server.ts) keeps its own self-contained IO because it
 * resolves the session against the host's working directory; this module
 * serves path-explicit consumers — today the ddboard CLI.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { parseSession, type DiagnosisSession } from "./schema.js";

/** Session file location, relative to the project root. */
export const SESSION_DIR = ".ddboard";
export const SESSION_FILE = path.join(SESSION_DIR, "session.json");

/** Format zod issues as the one-line-per-issue report shown to the operator. */
export function formatSessionIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join(".") || "session"}: ${issue.message}`)
    .join("\n");
}

/**
 * Load and validate a session file. ENOENT and malformed JSON become errors
 * with actionable guidance; a schema violation propagates as ZodError so
 * callers (e.g. `ddboard validate`) can print the per-issue report.
 */
export async function loadSessionFromFile(filePath: string): Promise<DiagnosisSession> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `会话文件不存在：${filePath} —— 先运行 ddboard init，或在 coding agent 里用 start_session 创建`,
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${filePath} 不是合法 JSON —— 会话文件是单一事实源，请修复后重试或从 git 历史回溯`,
    );
  }
  return parseSession(parsed);
}

/** Validate against the zod schema before every persist, then write pretty JSON. */
export async function saveSessionToFile(
  filePath: string,
  session: DiagnosisSession,
): Promise<void> {
  parseSession(session);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}
