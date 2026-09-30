/**
 * Conversation history per `sessionId`: in process, backed by one JSONL file
 * per session under `<data dir>/agent-sessions/`. Each turn runs on a fresh
 * harness session seeded with this transcript, so no harness persistence plugin is needed.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "@/server/agent/config";

export type SessionMessage = { role: "user" | "assistant"; content: string; at: string };

/** Transcript turns fed back to the model. */
const MAX_HISTORY_MESSAGES = 20;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const sessions = new Map<string, SessionMessage[]>();

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

function sessionFile(id: string): string {
  return join(dataDir(), "agent-sessions", `${id}.jsonl`);
}

function load(id: string): SessionMessage[] {
  const cached = sessions.get(id);
  if (cached) return cached;
  let messages: SessionMessage[] = [];
  try {
    messages = readFileSync(sessionFile(id), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as SessionMessage;
          return (row.role === "user" || row.role === "assistant") && typeof row.content === "string" ? [row] : [];
        } catch {
          return [];
        }
      });
  } catch {
    // No file yet: new session.
  }
  sessions.set(id, messages);
  return messages;
}

export function sessionHistory(id: string): SessionMessage[] {
  if (!isValidSessionId(id)) throw new Error(`Invalid session id: ${id}`);
  return load(id).slice(-MAX_HISTORY_MESSAGES);
}

export function appendSessionTurn(id: string, question: string, answer: string, now = new Date()): void {
  if (!isValidSessionId(id)) throw new Error(`Invalid session id: ${id}`);
  const rows: SessionMessage[] = [{ role: "user", content: question, at: now.toISOString() }];
  if (answer) rows.push({ role: "assistant", content: answer, at: now.toISOString() });
  load(id).push(...rows);
  mkdirSync(join(dataDir(), "agent-sessions"), { recursive: true });
  appendFileSync(sessionFile(id), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** Test-only: drop the in-process copies. */
export function resetSessions(): void {
  sessions.clear();
}
