import { removeItem } from "../storage";

/** A page or file an answer was drawn from (the server's `sources` event). */
export interface HelpSource {
  path: string;
  title: string;
  url: string;
}

/** Where an Ask channel answer's numbered reference opens (the server's `references`). */
export interface AskReference {
  n: number;
  channel: string;
  title: string;
  yt_id: string;
  published_at: string | null;
  start_sec: number;
  library_video_id: number | null;
  /** The caption line the reference opens at ("" for a description). */
  line: string;
  is_description: boolean;
}

/** An Ask channel a turn answered from. */
export interface AskScopeChannel {
  id: number;
  name: string | null;
}

export interface HelpMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: HelpSource[];
  /** Ask channel answers: the numbered references, in order. */
  references?: AskReference[];
  /** Ask channel answers: the channels it answered from. */
  channels?: AskScopeChannel[];
  /** While searching channels: what the server is doing. */
  status?: string;
}

/** This tab's copy of the conversation shown (the server keeps it too). */
export const HELP_CHAT_STORAGE_KEY = "horde.helpChat";

/** The saved conversation this tab shows and the Ask channels it is about. */
export const ASK_CHAT_STORAGE_KEY = "horde.askChat";

export interface AskChatState {
  threadId: number | null;
  scope: AskScopeChannel[];
}

export function isAskState(value: unknown): value is AskChatState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.threadId === null || typeof v.threadId === "number") &&
    Array.isArray(v.scope)
  );
}

/** Whether the panel is open and where it was dragged to, for this tab. */
export const HELP_PANEL_STORAGE_KEY = "horde.helpChatPanel";

/** Forget this tab's conversation and panel (on sign-out: the next person). */
export function clearHelpChatStorage() {
  removeItem(HELP_PANEL_STORAGE_KEY, "session");
  removeItem(HELP_CHAT_STORAGE_KEY, "session");
  removeItem(ASK_CHAT_STORAGE_KEY, "session");
}

/** The panel's element id, for the footer button's `aria-controls`. */
export const HELP_PANEL_ID = "horde-help-chat";

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

function isReference(value: unknown): value is AskReference {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.n === "number" &&
    typeof v.yt_id === "string" &&
    typeof v.start_sec === "number" &&
    typeof v.title === "string" &&
    typeof v.channel === "string"
  );
}

export function parseReferences(value: unknown): AskReference[] {
  return Array.isArray(value) ? value.filter(isReference) : [];
}

export function parseScopeChannels(value: unknown): AskScopeChannel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c): c is AskScopeChannel =>
      !!c &&
      typeof c === "object" &&
      typeof (c as AskScopeChannel).id === "number"
  );
}

/** A saved message's `sources` as the panel keeps them. */
export function savedSources(
  sources: unknown
): Pick<HelpMessage, "sources" | "references" | "channels"> {
  if (!sources || typeof sources !== "object") return {};
  const s = sources as Record<string, unknown>;
  if (s.kind === "channels") {
    return {
      references: parseReferences(s.references),
      channels: parseScopeChannels(s.channels),
    };
  }
  return { sources: parseSources(s.sources) };
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
