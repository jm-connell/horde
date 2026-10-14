import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { CompatCopyResolution, DownloadVideoCodec } from "../../hooks/useSettings";
import type { CompatSummary, SystemStats } from "../../types";
import { formatSize } from "../../utils";
import { probeDecodeSupport } from "../../utils/decodeCapability";
import { CHIP, CHIP_ACTIVE, PANEL_BTN } from "./constants";

type Level = "low" | "mid" | "high";

type ModeInfo = {
  id: DownloadVideoCodec;
  title: string;
  badge?: string;
  summary: string;
  storage: { level: Level; label: string };
  compute: { level: Level; label: string };
  details: string[];
  /** Conversion is part of normal operation → warn loudly without a GPU. */
  needsGpu: "required" | "partial" | "none";
};

const MODES: ModeInfo[] = [
  {
    id: "av1",
    title: "AV1 only",
    badge: "Recommended if your devices support it",
    summary: "Keep YouTube’s original AV1/VP9 files. Smallest files, full resolution (4K/HDR).",
    storage: { level: "low", label: "Smallest" },
    compute: { level: "low", label: "None" },
    details: [
      "Plays on recent devices: iPhone 15 Pro and newer, M3+ Macs and iPads, current Chrome / Edge / Firefox, most Android phones.",
      "Won’t play on M1/M2 iPads and Macs in Safari, older iPhones, many smart TVs and older PCs.",
      "If a device can’t play a video, Horde offers a one-tap H.264 copy for just that video.",
    ],
    needsGpu: "none",
  },
  {
    id: "h264_native",
    title: "H.264 only, up to 1080p",
    summary: "Download YouTube’s own H.264 version. Plays everywhere, but YouTube stops H.264 at 1080p.",
    storage: { level: "mid", label: "~1.5–2× AV1" },
    compute: { level: "low", label: "None" },
    details: [
      "Every device made in the last decade can play it.",
      "1440p and 4K downloads are saved at 1080p instead.",
      "No conversion: files are copied straight from YouTube.",
    ],
    needsGpu: "none",
  },
  {
    id: "h264_convert",
    title: "H.264 only, full resolution",
    summary: "Download AV1 for 1440p/4K, then convert it to H.264 on this server and replace the original.",
    storage: { level: "high", label: "~2–3× AV1 at 4K" },
    compute: { level: "high", label: "Heavy — GPU strongly advised" },
    details: [
      "Keeps 4K, but many older devices that need H.264 can’t decode 4K H.264 smoothly anyway.",
      "1080p and below still download YouTube’s H.264 directly (no conversion).",
      "Each 4K video is fully re-encoded. Originals are replaced, so there is a small quality loss.",
    ],
    needsGpu: "required",
  },
  {
    id: "sidecar",
    title: "AV1 + H.264 copy",
    badge: "Most compatible",
    summary: "Keep the full-quality AV1 original and save a ≤1080p H.264 copy beside it. Each device plays the best one it can.",
    storage: { level: "high", label: "Significantly more: +50–150%" },
    compute: { level: "mid", label: "Low for new downloads" },
    details: [
      "New YouTube downloads fetch YouTube’s H.264 version too: an extra download, no conversion.",
      "Existing videos, imports, and videos YouTube has no H.264 for are converted on this server, either on demand when a device needs one or all at once from Settings → Library.",
      "Nobody has to think about codecs: modern devices get 4K AV1, older ones get 1080p H.264.",
    ],
    needsGpu: "partial",
  },
];

const LEVEL_CLASS: Record<Level, string> = {
  low: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  mid: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  high: "border-amber-500/30 bg-amber-500/10 text-amber-300",
};

function Pill({ level, label, kind }: { level: Level; label: string; kind: string }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${LEVEL_CLASS[level]}`}>
      <span className="opacity-70">{kind}:</span> {label}
    </span>
  );
}

function hardwareSummary(stats: SystemStats | null | undefined): {
  hasGpuEncode: boolean;
  gpuName: string | null;
  encoderLabel: string;
  gpuVisibleButUnusable: boolean;
  /** Pascal/Turing GeForce (GTX 10/16, RTX 20): NVENC but no AV1 NVDEC. */
  nvidiaNoAv1Decode: boolean;
} {
  const enc = stats?.encode ?? null;
  const gpuName = enc?.gpu_name ?? stats?.gpu?.name ?? null;
  const hasGpuEncode = Boolean(enc?.hw_h264);
  const encoder = enc?.encoder_h264;
  const encoderLabel = encoder
    ? `${encoder} (${hasGpuEncode ? "GPU" : "CPU"})`
    : "No H.264 encoder found in ffmpeg";
  return {
    hasGpuEncode,
    gpuName,
    encoderLabel,
    gpuVisibleButUnusable: Boolean(gpuName && !enc?.ffmpeg_has_hw_encoder),
    nvidiaNoAv1Decode:
      encoder === "h264_nvenc" && /\b(GTX\s*1\d{3}|RTX\s*20\d{2}|TITAN\s*RTX)\b/i.test(gpuName ?? ""),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function cpuLabel(stats: SystemStats | null | undefined): string {
  const model = stats?.cpu_model?.trim();
  const cores = stats?.cpu_count;
  if (model && cores) return `${model}, ${cores} threads`;
  return model || (cores ? `${cores} CPU threads` : "the CPU");
}

/** Sidecar mode with full-resolution copies: 1440p/4K are encoded here. */
const SIDECAR_FULL_RES: Pick<ModeInfo, "summary" | "storage" | "compute" | "details" | "needsGpu"> = {
  summary:
    "Keep the full-quality AV1 original and save a full-resolution H.264 copy (up to 4K) beside it. Each device plays the best one it can.",
  storage: { level: "high", label: "Much more: +100–200% at 4K" },
  compute: { level: "high", label: "Heavy for 1440p/4K — GPU strongly advised" },
  details: [
    "1080p and lower: YouTube’s own H.264 is downloaded too, with no conversion.",
    "1440p and 4K: YouTube has no H.264 at these sizes, so a full-resolution H.264 copy is encoded on this server (up to 4K).",
    "Older devices that can’t decode AV1 often struggle with 4K H.264 as well. Use “Up to 1080p” if they stutter.",
  ],
  needsGpu: "required",
};

export default function PlaybackCompatPicker({
  mode,
  onChange,
  copyResolution,
  onCopyResolutionChange,
  stats,
  showLibraryActions = false,
}: {
  mode: DownloadVideoCodec;
  onChange: (mode: DownloadVideoCodec) => void;
  copyResolution: CompatCopyResolution;
  onCopyResolutionChange: (value: CompatCopyResolution) => void;
  stats?: SystemStats | null;
  /** Settings page: show library size estimates and bulk actions. */
  showLibraryActions?: boolean;
}) {
  const hw = hardwareSummary(stats);
  const [av1Here, setAv1Here] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    probeDecodeSupport()
      .then((s) => !cancelled && setAv1Here(s.av1Supported))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const fullRes = copyResolution === "source";
  const modes = MODES.map((m) =>
    m.id === "sidecar" && fullRes ? { ...m, ...SIDECAR_FULL_RES } : m,
  );
  const selected = modes.find((m) => m.id === mode) ?? modes[0];

  return (
    <div>
      <p className="text-sm font-medium text-gray-200">Playback compatibility</p>
      <p className="mt-0.5 text-xs text-gray-500">
        YouTube stores high-resolution video as AV1, which plays on most new
        devices but not on older iPads, iPhones, Macs and TVs. Pick how Horde
        balances storage, server work and device support.{" "}
        <a href="/wiki/guides/downloads/#compatibility-codecs" className="text-accent hover:underline">
          Learn more
        </a>
      </p>

      {/* Hardware detection */}
      <div className="ui-panel mt-3 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-gray-400">
            GPU:{" "}
            {hw.gpuName ? (
              <span className={hw.hasGpuEncode ? "text-emerald-300" : "text-amber-300"}>
                {hw.gpuName}
                {hw.hasGpuEncode ? " — usable for encoding" : " — not usable by Horde"}
              </span>
            ) : stats ? (
              <span className="text-gray-300">None detected</span>
            ) : (
              <span className="text-gray-500">Checking…</span>
            )}
          </span>
          {stats?.encode && (
            <span className="text-gray-400">
              Encoder: <span className="text-gray-300">{hw.encoderLabel}</span>
            </span>
          )}
          {av1Here != null && (
            <span className="text-gray-400">
              This device:{" "}
              <span className={av1Here ? "text-emerald-300" : "text-amber-300"}>
                {av1Here ? "can play AV1" : "can’t play AV1"}
              </span>
            </span>
          )}
        </div>
        {hw.gpuVisibleButUnusable && (
          <p className="mt-1.5 text-amber-300/90">
            {hw.gpuName} is on this machine, but Horde’s container can’t use it
            for encoding. Pass the GPU into the horde container (see the GPU
            section of the environment docs) and restart.
          </p>
        )}
      </div>

      {/* Modes */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Playback compatibility">
        {modes.map((m) => {
          const active = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(m.id)}
              className={`ui-panel ui-interactive rounded-lg border px-3 py-2.5 text-left transition-colors ${
                active
                  ? "border-accent/60 bg-accent/10"
                  : "border-ink-700 bg-ink-900 hover:border-accent/50"
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`h-3.5 w-3.5 shrink-0 rounded-full border ${
                    active ? "border-accent bg-accent shadow-[inset_0_0_0_2px_rgb(0_0_0/0.6)]" : "border-gray-500"
                  }`}
                />
                <span className="text-sm font-medium text-gray-100">{m.title}</span>
              </span>
              {m.badge && (
                <span className="mt-1 block text-[11px] font-medium text-accent">{m.badge}</span>
              )}
              <span className="mt-1 block text-xs text-gray-400">{m.summary}</span>
              <span className="mt-2 flex flex-wrap gap-1.5">
                <Pill kind="Storage" {...m.storage} />
                <Pill kind="Server work" {...m.compute} />
              </span>
            </button>
          );
        })}
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-gray-400">
        {selected.details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>

      {mode !== "h264_native" && (
        <CopyResolutionChoice
          mode={mode}
          value={copyResolution}
          onChange={onCopyResolutionChange}
        />
      )}

      <ModeWarnings
        mode={selected}
        hw={hw}
        stats={stats}
        av1Here={av1Here}
        fullResCopies={fullRes}
      />

      {showLibraryActions && (
        <LibraryActions mode={mode} hasGpuEncode={hw.hasGpuEncode} copyResolution={copyResolution} />
      )}
    </div>
  );
}

function CopyResolutionChoice({
  mode,
  value,
  onChange,
}: {
  mode: DownloadVideoCodec;
  value: CompatCopyResolution;
  onChange: (value: CompatCopyResolution) => void;
}) {
  const options: { id: CompatCopyResolution; title: string; hint: string }[] = [
    {
      id: "1080p",
      title: "Up to 1080p",
      hint: "Light: new downloads reuse YouTube’s H.264, and other copies are small 1080p encodes.",
    },
    {
      id: "source",
      title: "Full resolution",
      hint: "1440p/4K copies are encoded here at full size (up to 4K). Bigger files, much more GPU time.",
    },
  ];
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-gray-300">
        {mode === "sidecar" ? "H.264 copy resolution" : "Resolution of on-demand H.264 copies"}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="H.264 copy resolution">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            title={o.hint}
            onClick={() => onChange(o.id)}
            className={value === o.id ? CHIP_ACTIVE : CHIP}
          >
            {o.title}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-gray-500">{options.find((o) => o.id === value)?.hint}</p>
    </div>
  );
}

function ModeWarnings({
  mode,
  hw,
  stats,
  av1Here,
  fullResCopies,
}: {
  mode: ModeInfo;
  hw: ReturnType<typeof hardwareSummary>;
  stats?: SystemStats | null;
  av1Here: boolean | null;
  fullResCopies: boolean;
}) {
  const known = stats != null;
  const out: { tone: "warn" | "info"; text: string }[] = [];

  if (known && !hw.hasGpuEncode && mode.needsGpu === "required") {
    out.push({
      tone: "warn",
      text:
        `No GPU encoder detected, so every 1440p/4K ${mode.id === "sidecar" ? "copy" : "download"} will be converted on ${cpuLabel(stats)}. ` +
        "In software, 4K usually encodes at about 0.2–1× real time: a 20-minute 4K video can take 20–90+ minutes " +
        "and keep every core busy. Add a GPU to the container (NVIDIA GTX 16-series/RTX, Intel Quick Sync, or a recent AMD), " +
        (mode.id === "sidecar"
          ? "or set the copy resolution to “Up to 1080p”."
          : "or choose “H.264 only, up to 1080p”."),
    });
  }
  if (known && !hw.hasGpuEncode && fullResCopies && mode.needsGpu === "none") {
    out.push({
      tone: "warn",
      text: `Full-resolution copies of 1440p/4K videos would be encoded on ${cpuLabel(stats)}, which is very slow. “Up to 1080p” is a better fit without a GPU.`,
    });
  }
  if (known && !hw.hasGpuEncode && mode.needsGpu === "partial") {
    out.push({
      tone: "warn",
      text:
        "No GPU encoder detected. New YouTube downloads are fine (their H.264 copy is downloaded, not converted), " +
        `but copies for existing videos and imports will be converted on ${cpuLabel(stats)}. ` +
        "That is slow: expect minutes per video, longer for 4K.",
    });
  }
  if (known && hw.hasGpuEncode && hw.nvidiaNoAv1Decode && mode.needsGpu !== "none") {
    out.push({
      tone: "info",
      text:
        `${hw.gpuName} can’t decode AV1, so the CPU decodes it and the GPU only encodes. ` +
        "That’s still several times faster than real time at 1080p; 4K sources lean harder on the CPU.",
    });
  }
  if (mode.id === "av1" && av1Here === false) {
    out.push({
      tone: "warn",
      text:
        "This device can’t decode AV1. With AV1 only, it would need a converted copy for each video. Consider “AV1 + H.264 copy”.",
    });
  }
  if (mode.id === "h264_convert") {
    out.push({
      tone: "info",
      text: "Existing videos aren’t changed automatically. Use “Convert library to H.264” in Settings → Library to convert them.",
    });
  }

  if (!out.length) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {out.map((w) => (
        <p
          key={w.text}
          className={`text-xs ${w.tone === "warn" ? "text-amber-400/90" : "text-gray-500"}`}
        >
          {w.text}
        </p>
      ))}
    </div>
  );
}

function LibraryActions({
  mode,
  hasGpuEncode,
  copyResolution,
}: {
  mode: DownloadVideoCodec;
  hasGpuEncode: boolean;
  copyResolution: CompatCopyResolution;
}) {
  const [summary, setSummary] = useState<CompatSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmConvert, setConfirmConvert] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.getCompatSummary().then(setSummary).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);
  // The server sizes estimates with the saved copy resolution; refetch once
  // the debounced settings sync (300 ms) has landed.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = window.setTimeout(refresh, 800);
    return () => window.clearTimeout(t);
  }, [copyResolution, refresh]);

  const active =
    summary != null &&
    summary.queued + summary.running + summary.convert_queued + summary.convert_running > 0;

  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(refresh, 3000);
    return () => window.clearInterval(t);
  }, [active, refresh]);

  if (!summary || summary.videos === 0) return null;

  const run = (fn: () => Promise<{ queued: number }>, label: string) => {
    setBusy(true);
    setMessage(null);
    fn()
      .then((r) =>
        setMessage(
          r.queued ? `${label}: queued ${plural(r.queued, "video", "videos")}.` : `${label}: nothing new to queue.`,
        ),
      )
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : "Request failed"))
      .finally(() => {
        setBusy(false);
        setConfirmConvert(false);
        refresh();
      });
  };

  const cancel = (kind: "compat" | "convert") => {
    api
      .cancelCompatJobs(kind)
      .then((r) => setMessage(`Cancelled ${plural(r.cancelled, "job", "jobs")}.`))
      .catch(() => undefined)
      .finally(refresh);
  };

  const compatPending = summary.queued + summary.running;
  const convertPending = summary.convert_queued + summary.convert_running;

  return (
    <div className="ui-panel mt-4 space-y-3 rounded-lg border border-ink-700 bg-ink-900 px-3 py-3 text-xs">
      <p className="text-gray-400">
        Library: {plural(summary.videos, "video", "videos")}, {formatSize(summary.library_bytes)}
        {summary.compat_ready > 0 &&
          ` · ${summary.compat_ready} H.264 copies (${formatSize(summary.compat_bytes)})`}
        {summary.unprobed > 0 && ` · checking codecs of ${summary.unprobed}…`}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-gray-200">Create H.264 copies for the library</p>
          <p className="text-gray-500">
            {summary.compat_missing > 0
              ? `${plural(summary.compat_missing, "video has", "videos have")} no H.264 copy. Estimated +${formatSize(summary.compat_missing_est_bytes)}, ` +
                (hasGpuEncode ? "converted on the GPU" : "converted on the CPU (slow)") +
                "; YouTube’s own H.264 is downloaded when available."
              : "Every video already plays on older devices."}
          </p>
          {mode !== "sidecar" && summary.compat_missing > 0 && (
            <p className="text-gray-500">
              Tip: with “AV1 + H.264 copy”, new downloads get one automatically.
            </p>
          )}
        </div>
        {compatPending > 0 ? (
          <span className="flex items-center gap-2 text-gray-300">
            {summary.running} running · {summary.queued} queued
            <button type="button" className={PANEL_BTN} onClick={() => cancel("compat")}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={PANEL_BTN}
            disabled={busy || summary.compat_missing === 0}
            onClick={() => run(api.startCompatBackfill, "H.264 copies")}
          >
            {summary.compat_missing === 1 ? "Create 1 copy" : `Create ${summary.compat_missing || ""} copies`}
          </button>
        )}
      </div>

      {mode === "h264_convert" && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700 pt-3">
          <div className="min-w-0">
            <p className="text-sm text-gray-200">Convert library to H.264</p>
            <p className="text-gray-500">
              {summary.convertible > 0
                ? `Re-encodes ${plural(summary.convertible, "AV1/VP9 original", "AV1/VP9 originals")} (${formatSize(summary.convertible_bytes)}) to H.264 at full resolution and replaces them. ` +
                  "Files usually grow 2–3× at 4K. The only way back is to download them again."
                : "Every original is already H.264."}
            </p>
            {!hasGpuEncode && summary.convertible > 0 && (
              <p className="text-amber-400/90">
                No GPU encoder: converting {plural(summary.convertible, "video", "videos")} on the CPU could take days.
              </p>
            )}
          </div>
          {convertPending > 0 ? (
            <span className="flex items-center gap-2 text-gray-300">
              {summary.convert_running} running · {summary.convert_queued} queued
              <button type="button" className={PANEL_BTN} onClick={() => cancel("convert")}>
                Cancel
              </button>
            </span>
          ) : confirmConvert ? (
            <span className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg border border-red-500/50 bg-red-500/15 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/25"
                disabled={busy}
                onClick={() => run(api.convertLibraryToH264, "Conversion")}
              >
                Replace {plural(summary.convertible, "original", "originals")}
              </button>
              <button type="button" className={PANEL_BTN} onClick={() => setConfirmConvert(false)}>
                Keep originals
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={PANEL_BTN}
              disabled={busy || summary.convertible === 0}
              onClick={() => setConfirmConvert(true)}
            >
              Convert library…
            </button>
          )}
        </div>
      )}

      {message && <p className="text-gray-400">{message}</p>}
    </div>
  );
}
