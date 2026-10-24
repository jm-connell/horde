import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useUpdateAppSettings } from "../queries/app";
import { dataOrNull, useSystemStats } from "../queries/status";
import Collapse from "../components/Collapse";
import {
  flushSettingsSync,
  markSetupCompleted,
  useSettings,
  type Settings,
} from "../hooks/useSettings";
import type { HealthStats, SystemStats } from "../types";
import { formatSize } from "../utils";
import PlaybackCompatPicker from "./settings/PlaybackCompatPicker";
import ThemePalettePicker from "./settings/ThemePalettePicker";
import { Toggle } from "./settings/ui";
import {
  AI_PROVIDER_PRESETS,
  INPUT,
  INPUT_KEY,
  PANEL_BTN,
} from "./settings/constants";
import ThemedSelect from "../components/ThemedSelect";

const STEPS = [
  "welcome",
  "downloads",
  "playback",
  "look",
  "ai",
  "done",
] as const;
type Step = (typeof STEPS)[number];
type AiChoice = "skip" | "cloud" | "server" | "bundled";

/** The compose service `docker compose --profile ai up -d` starts. */
const BUNDLED_OLLAMA_URL = "http://ollama:11434/v1";
const CLOUD_PRESETS = AI_PROVIDER_PRESETS.filter((p) => p.needsKey);

const STEP_TITLE: Record<Step, string> = {
  welcome: "Welcome",
  downloads: "Downloads",
  playback: "Playback compatibility",
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
  const saveAppSettings = useUpdateAppSettings();
  const [settings, update] = useSettings();
  const [step, setStep] = useState<Step>("welcome");
  const [health, setHealth] = useState<HealthStats | null>(null);
  const systemStats = dataOrNull(useSystemStats());
  const [finishing, setFinishing] = useState(false);
  const [aiChoice, setAiChoice] = useState<AiChoice>("skip");
  const [cloudPreset, setCloudPreset] = useState(CLOUD_PRESETS[0].id);
  const [cloudKey, setCloudKey] = useState("");
  const [serverUrl, setServerUrl] = useState("");
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
      await saveAppSettings({ setup_completed: true });
      markSetupCompleted();
      navigate((health?.library_video_count ?? 0) > 0 ? "/" : "/download", {
        replace: true,
      });
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

  /**
   * Test an endpoint and save it with models: the preset's suggestions, an
   * Ollama server's GPU-sized picks (downloaded in the background), or the
   * first models the server lists.
   */
  const connectAi = async (
    url: string,
    key: string,
    presetModels?: {
      chat?: string;
      embed?: string;
    }
  ) => {
    setAiBusy(true);
    setAiStatus(null);
    try {
      const result = await api.testAiConnection({
        base_url: url,
        api_key: key || null,
      });
      if (!result.ok) {
        setAiStatus(result.detail || "Could not reach that server.");
        return;
      }
      const listed = result.models ?? [];
      const embeds = result.embedding_models ?? [];
      const isOllama = result.kind === "ollama";
      const chat =
        presetModels?.chat ||
        (isOllama ? "llama3.2:3b" : "") ||
        listed.find((m) => !embeds.some((e) => e.id === m.id))?.id ||
        "";
      const embed =
        presetModels?.embed ||
        (isOllama ? "nomic-embed-text" : "") ||
        embeds[0]?.id ||
        "";
      await saveAppSettings({
        ai: {
          enabled: true,
          base_url: result.base_url ?? url,
          api_key: key,
          chat_model: chat,
          embed_model: embed,
        },
      });
      if (isOllama) {
        // Picks models that fit the Ollama GPU and starts downloading them.
        await api.applyAiWorkload();
        setAiStatus(
          "Connected to Ollama. Models are downloading in the background; AI features start once they finish."
        );
      } else {
        setAiStatus(
          chat
            ? "Connected. You can continue."
            : "Connected. Pick a chat model later in Settings → AI."
        );
      }
      goNext();
    } catch (err) {
      setAiStatus(
        err instanceof Error ? err.message : "Connection test failed."
      );
    } finally {
      setAiBusy(false);
    }
  };

  const saveCloud = async () => {
    const preset = CLOUD_PRESETS.find((p) => p.id === cloudPreset);
    const key = cloudKey.trim();
    if (!preset) return;
    if (!key) {
      setAiStatus("Paste an API key first.");
      return;
    }
    await connectAi(preset.url, key, preset);
  };

  const saveServer = async () => {
    const url = serverUrl.trim();
    if (!url) {
      setAiStatus("Enter the server address first.");
      return;
    }
    await connectAi(url, "");
  };

  const saveBundled = () => connectAi(BUNDLED_OLLAMA_URL, "");

  const panelProps: Omit<WizardPanelProps, "step"> = {
    settings,
    update,
    health,
    systemStats,
    finishing,
    aiChoice,
    setAiChoice,
    cloudPreset,
    setCloudPreset,
    cloudKey,
    setCloudKey,
    serverUrl,
    setServerUrl,
    aiStatus,
    setAiStatus,
    aiBusy,
    goNext,
    goBack,
    finish,
    saveCloud,
    saveServer,
    saveBundled,
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

      <div
        ref={wrapRef}
        className={`relative mt-6 overflow-hidden ${HEIGHT_EASE}`}
      >
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
  cloudPreset: string;
  setCloudPreset: (value: string) => void;
  cloudKey: string;
  setCloudKey: (value: string) => void;
  serverUrl: string;
  setServerUrl: (value: string) => void;
  aiStatus: string | null;
  setAiStatus: (value: string | null) => void;
  aiBusy: boolean;
  goNext: () => void;
  goBack: () => void;
  finish: () => void | Promise<void>;
  saveCloud: () => void | Promise<void>;
  saveServer: () => void | Promise<void>;
  saveBundled: () => void | Promise<void>;
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
  cloudPreset,
  setCloudPreset,
  cloudKey,
  setCloudKey,
  serverUrl,
  setServerUrl,
  aiStatus,
  setAiStatus,
  aiBusy,
  goNext,
  goBack,
  finish,
  saveCloud,
  saveServer,
  saveBundled,
}: WizardPanelProps) {
  const stepIndex = STEPS.indexOf(step);
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-100">
        {STEP_TITLE[step]}
      </h1>
      <p className="mt-1 text-xs text-muted">
        Step {stepIndex + 2} of {STEPS.length + 1}
      </p>

      <div className="mt-8 space-y-4">
        {step === "welcome" && (
          <>
            <p className="text-sm text-gray-300">
              Horde is a self-hosted media archive. Everyone signs in with their
              own account and keeps their own watch history; as the
              administrator you choose who can delete, download and change
              settings.
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
              <p className="text-xs text-muted">
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
                <span className="block text-xs text-muted">
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
          </>
        )}

        {step === "playback" && (
          <>
            <p className="text-sm text-gray-400">
              Decide which devices can play your library. You can change this
              later in Settings → Library, and switching never deletes videos.
            </p>
            <PlaybackCompatPicker
              mode={settings.downloadVideoCodec}
              onChange={(id) => update({ downloadVideoCodec: id })}
              copyResolution={settings.compatCopyResolution}
              onCopyResolutionChange={(v) =>
                update({ compatCopyResolution: v })
              }
              stats={systemStats}
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
              AI is optional: summaries, chapters, chat about a video, smarter
              tags and semantic search. Skip for now and set it up later in
              Settings → AI.
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: "skip" as const, label: "Skip for now" },
                  { id: "cloud" as const, label: "Cloud provider" },
                  { id: "server" as const, label: "My own server" },
                  { id: "bundled" as const, label: "Run Ollama for me" },
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
            <Collapse open={aiChoice === "cloud"}>
              <div className="space-y-2 pt-2">
                <p className="text-xs text-muted">
                  No GPU needed. Titles, captions and chat messages are sent to
                  the provider. The key is stored on this Horde server.
                  OpenRouter reaches most models with one key and reports what
                  each call costs.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <ThemedSelect
                    aria-label="Cloud provider"
                    value={cloudPreset}
                    options={CLOUD_PRESETS.map((p) => ({
                      value: p.id,
                      label: p.label,
                    }))}
                    onChange={setCloudPreset}
                    className="w-48"
                    buttonClassName="w-full"
                  />
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="API key"
                    aria-label="API key"
                    value={cloudKey}
                    onChange={(e) => setCloudKey(e.target.value)}
                    className={INPUT_KEY}
                  />
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={() => void saveCloud()}
                    className={PANEL_BTN}
                  >
                    {aiBusy ? "Testing…" : "Test and save"}
                  </button>
                </div>
              </div>
            </Collapse>
            <Collapse open={aiChoice === "server"}>
              <div className="space-y-2 pt-2">
                <p className="text-xs text-muted">
                  Ollama, LM Studio, llama.cpp, vLLM or anything else with an
                  OpenAI-compatible API. Horde runs in Docker, so use{" "}
                  <span className="font-mono">host.docker.internal</span> for a
                  server on this machine, or the LAN address of another PC, e.g.{" "}
                  <span className="font-mono">http://192.168.1.50:11434</span>.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    placeholder="http://host.docker.internal:11434"
                    aria-label="Server address"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    className={INPUT}
                  />
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={() => void saveServer()}
                    className={PANEL_BTN}
                  >
                    {aiBusy ? "Testing…" : "Test and save"}
                  </button>
                </div>
              </div>
            </Collapse>
            <Collapse open={aiChoice === "bundled"}>
              <div className="space-y-2 pt-2">
                <p className="text-xs text-muted">
                  Horde&apos;s compose file defines an optional Ollama
                  container, but it is not installed or started by default. This
                  command downloads the Ollama image the first time (a large
                  download) and starts it next to Horde; run it from the folder
                  holding <span className="font-mono">docker-compose.yml</span>:
                </p>
                <pre className="ui-panel overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-gray-200">
                  docker compose --profile ai up -d
                </pre>
                <p className="text-xs text-muted">
                  Then connect: Horde picks models that fit your GPU and
                  downloads them (a few GB). Without a GPU passed to the
                  container, Ollama runs on the CPU, which is slow.
                </p>
                <button
                  type="button"
                  disabled={aiBusy}
                  onClick={() => void saveBundled()}
                  className={PANEL_BTN}
                >
                  {aiBusy ? "Connecting…" : "Connect to the Ollama container"}
                </button>
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
