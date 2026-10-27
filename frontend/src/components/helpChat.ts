import type { HelpChatTurn } from "../types";

/** A page or file an answer was drawn from (the server's `sources` event). */
export interface HelpSource {
  path: string;
  title: string;
  url: string;
}

export interface HelpMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: HelpSource[];
}

/** This tab's conversation (sessionStorage; the server keeps none). */
export const HELP_CHAT_STORAGE_KEY = "horde.helpChat";

/** Turns sent back with each question; the server accepts at most 24. */
const MAX_HISTORY = 12;
/** Per-turn cap the server enforces. */
const MAX_TURN_CHARS = 8000;

export const HELP_SUGGESTIONS = [
  "How do I set up AI features?",
  "Why would a download fail?",
  "How do I add another account?",
  "Where are my videos stored on disk?",
];

function isSource(value: unknown): value is HelpSource {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    typeof v.title === "string" &&
    typeof v.url === "string"
  );
}

export function parseSources(value: unknown): HelpSource[] {
  return Array.isArray(value) ? value.filter(isSource) : [];
}

export function isHelpThread(value: unknown): value is HelpMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (m) =>
        !!m &&
        typeof m === "object" &&
        typeof (m as HelpMessage).id === "string" &&
        ((m as HelpMessage).role === "user" ||
          (m as HelpMessage).role === "assistant") &&
        typeof (m as HelpMessage).content === "string"
    )
  );
}

/** The finished turns to send with the next question, newest last. */
export function historyForRequest(messages: HelpMessage[]): HelpChatTurn[] {
  return messages
    .filter((m) => m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, MAX_TURN_CHARS),
    }));
}
