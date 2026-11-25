// desktop.json: the shell's own choices (port, media folder, sharing, which
// notices were shown, an update in flight). Horde's settings stay in the server.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PendingUpdate } from "./logic";

export const DEFAULT_PORT = 8686;

export interface DesktopConfig {
  port: number;
  mediaDir: string;
  shareOnNetwork: boolean;
  welcomed: boolean;
  closeNoticeShown: boolean;
  pendingUpdate: PendingUpdate | null;
}

export interface LoadedConfig {
  config: DesktopConfig;
  /** False when no port was saved yet: the first run picks one. */
  portSaved: boolean;
}

function isPending(v: unknown): v is PendingUpdate {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    (p.requestId === null || typeof p.requestId === "string") &&
    typeof p.fromVersion === "string" &&
    typeof p.toVersion === "string" &&
    typeof p.startedAt === "string" &&
    (p.reopenWindow === null || typeof p.reopenWindow === "boolean")
  );
}

export function loadConfig(
  file: string,
  defaultMediaDir: string,
  log: (msg: string) => void
): LoadedConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`could not read ${file}, using defaults: ${String(err)}`);
    }
  }
  const port =
    typeof raw.port === "number" &&
    Number.isInteger(raw.port) &&
    raw.port > 0 &&
    raw.port < 65_536
      ? raw.port
      : null;
  return {
    portSaved: port !== null,
    config: {
      port: port ?? DEFAULT_PORT,
      mediaDir:
        typeof raw.mediaDir === "string" && raw.mediaDir
          ? raw.mediaDir
          : defaultMediaDir,
      shareOnNetwork: raw.shareOnNetwork === true,
      welcomed: raw.welcomed === true,
      closeNoticeShown: raw.closeNoticeShown === true,
      pendingUpdate: isPending(raw.pendingUpdate) ? raw.pendingUpdate : null,
    },
  };
}

/** Write atomically (temp file in the same folder, then rename). */
export function saveConfig(file: string, config: DesktopConfig): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}
