import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import Collapse from "../components/Collapse";
import {
  flushSettingsSync,
  markSetupCompleted,
  useSettings,
  type Settings,
} from "../hooks/useSettings";
import type { HealthStats, SystemStats } from "../types";
import { formatSize } from "../utils";
import ArchiveCodecPicker from "./settings/ArchiveCodecPicker";
import ThemePalettePicker from "./settings/ThemePalettePicker";
import { Toggle } from "./settings/ui";
import { INPUT, INPUT_KEY, PANEL_BTN } from "./settings/constants";

const STEPS = ["welcome", "downloads", "look", "ai", "done"] as const;
type Step = (typeof STEPS)[number];
type AiChoice = "skip" | "openrouter" | "ollama";

const STEP_TITLE: Record<Step, string> = {
  welcome: "Welcome",
  downloads: "Downloads",
  look: "Look",
  ai: "AI (optional)",
  done: "You’re set",
};

const STEP_MS = 300;

const PRIMARY_BTN =
  "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-50";
const GHOST_BTN =
  "rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50";
const HEIGHT_EASE =
  "transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

export default function Setup() {
  const navigate = useNavigate();
  const [settings, update] = useSettings();
  const [step, setStep] = useState<Step>("welcome");
  const [health, setHealth] = useState<HealthStats | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [aiChoice, setAiChoice] = useState<AiChoice>("skip");
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [leaving, setLeaving] = useState<Step | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);
  const [moved, setMoved] = useState(false);
  const prevStepRef = useRef(step);
  const wrapRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => undefined);
    api.getSystemStats().then(setSystemStats).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (step === prevStepRef.current) return;
    const from = prevStepRef.current;
    setDir(STEPS.indexOf(step) > STEPS.indexOf(from) ? 1 : -1);
    setLeaving(from);
    setMoved(true);
    prevStepRef.current = step;
    const t = window.setTimeout(() => setLeaving(null), STEP_MS + 20);
    return () => window.clearTimeout(t);
  }, [step]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const inner = incomingRef.current;
    if (!wrap || !inner) return;

    const applyHeight = (next: number, animate: boolean) => {
      const from = heightRef.current;
      if (animate && from != null && from !== next) {
        wrap.style.height = `${from}px`;
        void wrap.offsetHeight;
      }
      wrap.style.height = `${next}px`;
      heightRef.current = next;
    };

    applyHeight(inner.offsetHeight, true);
    const ro = new ResizeObserver(() => {
      applyHeight(inner.offsetHeight, true);
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [step]);

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await flushSettingsSync();
      await api.updateAppSettings({ setup_completed: true });
      markSetupCompleted();
      navigate(
        (health?.library_video_count ?? 0) > 0 ? "/" : "/download",
        { replace: true }
      );
    } catch {
      setFinishing(false);
    }
  };

  const stepIndex = STEPS.indexOf(step);
  const animating = leaving != null;
  const goNext = () => {
    if (animating) return;
    setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]);
  };
  const goBack = () => {
    if (animating) return;
    setStep(STEPS[Math.max(stepIndex - 1, 0)]);
  };

  const saveOpenRouter = async () => {
    const key = openRouterKey.trim();
    if (!key) {
      setAiStatus("Paste an API key first.");
      return;
    }
    setAiBusy(true);
    setAiStatus(null);
    try {
      const result = await api.testOpenRouterConnection(key);
      if (!result.ok) {
        setAiStatus(result.detail || "Could not reach OpenRouter.");
        return;
      }
      await api.updateAppSettings({
        ai: {
          enabled: true,
          openrouter_enabled: true,
          openrouter_api_key: key,
        },
      });
      setAiStatus("OpenRouter connected. You can continue.");
      goNext();
    } catch (err) {
      setAiStatus(err instanceof Error ? err.message : "OpenRouter test failed.");
    } finally {
      setAiBusy(false);
    }
  };

  const saveOllama = async () => {
    setAiBusy(true);
    setAiStatus(null);
    try {
      const url = ollamaUrl.trim();
      const result = await api.testAiConnection(url || undefined);
      if (!result.ok) {
        setAiStatus(result.detail || "Could not reach Ollama.");
        return;
      }
      await api.updateAppSettings({
        ai: { enabled: true, base_url: url },
      });
      setAiStatus("Ollama connected. You can continue.");
      goNext();
    } catch (err) {
      setAiStatus(err instanceof Error ? err.message : "Ollama test failed.");
    } finally {
      setAiBusy(false);
    }
  };

  const panelProps: Omit<WizardPanelProps, "step"> = {
    settings,
    update,
    health,
    systemStats,
    finishing,
    aiChoice,
    setAiChoice,
    openRouterKey,
    setOpenRouterKey,
    ollamaUrl,
    setOllamaUrl,
    aiStatus,
    setAiStatus,
    aiBusy,
    goNext,
    goBack,
    finish,
    saveOpenRouter,
    saveOllama,
  };

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <p className="text-xs font-semibold uppercase tracking-wider text-accent">
        Horde setup
      </p>
      <div className="mt-3 flex gap-1">
        {STEPS.map((id, i) => (
          <span
            key={id}
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              i <= stepIndex ? "bg-accent" : "bg-ink-700"
            }`}
          />
        ))}
      </div>

      <div ref={wrapRef} className={`relative mt-6 overflow-hidden ${HEIGHT_EASE}`}>
        {leaving != null ? (
          <div
            className={`pointer-events-none absolute inset-x-0 top-0 ${
              dir === 1 ? "wizard-step-out-next" : "wizard-step-out-prev"
            }`}
            aria-hidden
          >
            <WizardPanel step={leaving} {...panelProps} />
          </div>
        ) : null}
        <div
          ref={incomingRef}
          key={step}
          className={
            moved
              ? dir === 1
                ? "wizard-step-in-next"
                : "wizard-step-in-prev"
              : undefined
          }
        >
          <WizardPanel step={step} {...panelProps} />
        </div>
      </div>
    </div>
  );
}

type WizardPanelProps = {
  step: Step;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  health: HealthStats | null;
  systemStats: SystemStats | null;
  finishing: boolean;
  aiChoice: AiChoice;
  setAiChoice: (choice: AiChoice) => void;
  openRouterKey: string;
  setOpenRouterKey: (value: string) => void;
  ollamaUrl: string;
  setOllamaUrl: (value: string) => void;
  aiStatus: string | null;
  setAiStatus: (value: string | null) => void;
  aiBusy: boolean;
  goNext: () => void;
  goBack: () => void;
  finish: () => void | Promise<void>;
  saveOpenRouter: () => void | Promise<void>;
  saveOllama: () => void | Promise<void>;
};

function WizardPanel({
  step,
  settings,
  update,
  health,
  systemStats,
  finishing,
  aiChoice,
  setAiChoice,
  openRouterKey,
  setOpenRouterKey,
  ollamaUrl,
  setOllamaUrl,
  aiStatus,
  setAiStatus,
  aiBusy,
  goNext,
  goBack,
  finish,
  saveOpenRouter,
  saveOllama,
}: WizardPanelProps) {
  const stepIndex = STEPS.indexOf(step);
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-100">
        {STEP_TITLE[step]}
      </h1>
      <p className="mt-1 text-xs text-gray-500">
        Step {stepIndex + 1} of {STEPS.length}
      </p>

      <div className="mt-8 space-y-4">
        {step === "welcome" && (
          <>
            <p className="text-sm text-gray-300">
              Horde is a single-admin media archive for a trusted LAN. There is
              no login — anyone who can reach this URL can download, delete, and
              change settings.
            </p>
            <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-4 py-3 text-sm text-gray-300">
              <p>
                Library:{" "}
                <span className="text-gray-100">
                  {health
                    ? `${health.library_video_count} video${
                        health.library_video_count === 1 ? "" : "s"
                      }`
                    : "…"}
                </span>
              </p>
              <p className="mt-1">
                Disk free:{" "}
                <span className="text-gray-100">
                  {health?.disk
                    ? `${formatSize(health.disk.free_bytes) || "0 B"} of ${
                        formatSize(health.disk.total_bytes) || "0 B"
                      }`
                    : "…"}
                </span>
              </p>
            </div>
            {health?.wiki_available ? (
              <p className="text-xs text-gray-500">
                Docs stay available at{" "}
                <a
                  href="/wiki/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  /wiki/
                </a>
                .
              </p>
            ) : null}
          </>
        )}

        {step === "downloads" && (
          <>
            <p className="text-sm text-gray-400">
              New downloads use these defaults. You can change them later in
              Settings → Library.
            </p>
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-gray-200">
                  Normalize volume on download
                </span>
                <span className="block text-xs text-gray-500">
                  Apply loudness normalization when saving new videos (requires
                  ffmpeg).
                </span>
              </span>
              <Toggle
                checked={settings.normalizeVolumeOnDownload}
                onChange={() =>
                  update({
                    normalizeVolumeOnDownload:
                      !settings.normalizeVolumeOnDownload,
                  })
                }
              />
            </label>
            <ArchiveCodecPicker
              codec={settings.downloadVideoCodec}
              onChange={(id) => update({ downloadVideoCodec: id })}
              encode={systemStats?.encode}
            />
          </>
        )}

        {step === "look" && (
          <>
            <p className="text-sm text-gray-400">
              Pick a color palette. Fonts, backgrounds, and custom CSS live in
              Settings → Appearance.
            </p>
            <ThemePalettePicker
              theme={settings.theme}
              onChange={(theme) => update({ theme })}
            />
          </>
        )}

        {step === "ai" && (
          <>
            <p className="text-sm text-gray-400">
              AI is optional. Skip for now and enable it later in Settings →
              AI.
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: "skip" as const, label: "Skip for now" },
                  { id: "openrouter" as const, label: "OpenRouter" },
                  { id: "ollama" as const, label: "Local Ollama" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setAiChoice(opt.id);
                    setAiStatus(null);
                  }}
                  className={
                    aiChoice === opt.id
                      ? "ui-panel rounded-lg border border-accent/50 bg-accent/15 px-3 py-1.5 text-sm text-accent"
                      : PANEL_BTN
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <Collapse open={aiChoice === "openrouter"}>
              <div className="space-y-2 pt-2">
                <p className="text-xs text-gray-500">
                  Cloud LLM for summaries, tags, and chat. The key is stored on
                  this Horde server.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="sk-or-…"
                    value={openRouterKey}
                    onChange={(e) => setOpenRouterKey(e.target.value)}
                    className={INPUT_KEY}
                  />
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={() => void saveOpenRouter()}
                    className={PANEL_BTN}
                  >
                    {aiBusy ? "Testing…" : "Test and save"}
                  </button>
                </div>
              </div>
            </Collapse>
            <Collapse open={aiChoice === "ollama"}>
              <div className="space-y-2 pt-2">
                <p className="text-xs text-gray-500">
                  Leave the URL blank to use the default (Docker Compose{" "}
                  <span className="font-mono">ai</span> profile, or localhost).
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    placeholder="http://127.0.0.1:11434"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    className={INPUT}
                  />
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={() => void saveOllama()}
                    className={PANEL_BTN}
                  >
                    {aiBusy ? "Testing…" : "Test and save"}
                  </button>
                </div>
              </div>
            </Collapse>
            {aiStatus ? (
              <p className="text-xs text-gray-400">{aiStatus}</p>
            ) : null}
          </>
        )}

        {step === "done" && (
          <p className="text-sm text-gray-300">
            {(health?.library_video_count ?? 0) > 0
              ? "Your library is ready. Open Home to keep watching, or Downloads when you want to add more. Everything else is in Settings."
              : "Paste a YouTube (or other yt-dlp) URL on the next screen to archive your first video. Everything else is in Settings."}
          </p>
        )}
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-2">
        {step !== "welcome" && (
          <button type="button" onClick={goBack} className={GHOST_BTN}>
            Back
          </button>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {step === "welcome" && (
            <button
              type="button"
              onClick={() => void finish()}
              disabled={finishing}
              className={GHOST_BTN}
            >
              Use defaults
            </button>
          )}
          {step === "ai" && aiChoice === "skip" && (
            <button type="button" onClick={goNext} className={PRIMARY_BTN}>
              Skip
            </button>
          )}
          {step !== "done" && step !== "ai" && (
            <button type="button" onClick={goNext} className={PRIMARY_BTN}>
              Continue
            </button>
          )}
          {step === "ai" && aiChoice !== "skip" && (
            <button type="button" onClick={goNext} className={GHOST_BTN}>
              Skip
            </button>
          )}
          {step === "done" && (
            <button
              type="button"
              onClick={() => void finish()}
              disabled={finishing}
              className={PRIMARY_BTN}
            >
              {finishing
                ? "Saving…"
                : (health?.library_video_count ?? 0) > 0
                  ? "Open library"
                  : "Go to Downloads"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
