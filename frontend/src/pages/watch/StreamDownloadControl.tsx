import { useRef } from "react";
import ThemedSelect from "../../components/ThemedSelect";
import { MenuFlyout, MenuScroll } from "../../components/MenuFlyout";
import { useAuth } from "../../context/AuthContext";
import { presetOptionLabel, resolveQualityPreset } from "../../presets";
import { downloadProcessingLabel, formatSize } from "../../utils";
import type { StreamDownload } from "./useStreamDownload";

function downloadButtonLabel(preset: string): string {
  if (preset === "best") return "Download Best Quality";
  if (preset === "audio") return "Download Audio Only";
  if (preset === "2160p") return "Download 4K";
  return `Download ${preset}`;
}

/** The download button, quality menu and live progress shown beside a previewed stream's title. */
export default function StreamDownloadControl({
  download,
}: {
  download: StreamDownload;
}) {
  const { can } = useAuth();
  const presetTriggerRef = useRef<HTMLButtonElement>(null);
  const {
    queuing,
    selectedPreset,
    setSelectedPreset,
    availablePresets,
    presetSizes,
    presetMenuOpen,
    setPresetMenuOpen,
    downloadMenuRef,
    userPickedPresetRef,
    presetOptions,
    live,
    activeJob,
    downloadPercent,
    downloadActive,
    handleStreamDownload,
    handleChangeDownloadQuality,
  } = download;

  return (
    <>
      {!downloadActive && can("download") && (
        <div className="relative" ref={downloadMenuRef}>
          <div className="inline-flex overflow-hidden rounded-lg bg-accent text-xs font-medium text-on-accent hover:bg-accent-soft disabled:opacity-60">
            <button
              type="button"
              onClick={() => void handleStreamDownload()}
              disabled={queuing}
              className="px-3 py-1 disabled:opacity-60"
            >
              {queuing ? "Queuing…" : downloadButtonLabel(selectedPreset)}
            </button>
            <button
              ref={presetTriggerRef}
              type="button"
              onClick={() => setPresetMenuOpen((v) => !v)}
              disabled={queuing}
              aria-label="Choose download quality"
              aria-expanded={presetMenuOpen}
              aria-haspopup="menu"
              className="border-l border-ink-950/25 px-2 py-1 disabled:opacity-60"
            >
              <span
                className={`inline-block text-[10px] leading-none transition-transform ${
                  presetMenuOpen ? "rotate-180" : ""
                }`}
              >
                ▼
              </span>
            </button>
          </div>
          <MenuFlyout
            open={presetMenuOpen}
            className="absolute right-0 z-30 mt-1 min-w-48 sm:left-0 sm:right-auto"
            menu={{
              label: "Download quality",
              onClose: () => setPresetMenuOpen(false),
              triggerRef: presetTriggerRef,
            }}
          >
            <MenuScroll className="max-h-60" revision={presetOptions.length}>
              <ul role="none">
                {presetOptions.map((p) => (
                  <li key={p} role="none">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={p === selectedPreset}
                      onClick={() => {
                        userPickedPresetRef.current = true;
                        setSelectedPreset(p);
                        setPresetMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-xs hover:bg-ink-800 ${
                        p === selectedPreset
                          ? "font-semibold text-accent"
                          : "text-gray-200"
                      }`}
                    >
                      <span>{presetOptionLabel(p, presetSizes)}</span>
                      {p === selectedPreset && (
                        <span className="text-accent">✓</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </MenuScroll>
          </MenuFlyout>
        </div>
      )}
      {downloadActive && (
        <span className="inline-flex items-center gap-2 text-xs font-medium text-gray-300">
          <span>
            {live?.status === "processing"
              ? downloadProcessingLabel(live?.stage)
              : live?.status === "queued"
                ? "Queued…"
                : `Downloading ${downloadPercent}%`}
          </span>
          <span className="inline-block h-1 w-12 overflow-hidden rounded-full bg-ink-800 sm:w-20">
            <span
              className="block h-full w-full rounded-full bg-accent/70 transition-transform duration-300 ease-linear"
              style={{ transform: `translateX(${downloadPercent - 100}%)` }}
            />
          </span>
          {(live?.downloaded_bytes != null || live?.total_bytes != null) && (
            <span className="text-[10px] text-muted max-sm:hidden">
              {live.downloaded_bytes != null
                ? formatSize(live.downloaded_bytes)
                : "…"}
              {live.total_bytes != null
                ? ` / ${formatSize(live.total_bytes)}`
                : ""}
            </span>
          )}
          {presetOptions.length > 0 && (
            <ThemedSelect
              aria-label="Download resolution"
              size="compact"
              value={resolveQualityPreset(
                activeJob?.quality_preset || selectedPreset,
                activeJob?.available_presets ?? availablePresets
              )}
              options={presetOptions.map((p) => ({
                value: p,
                label: presetOptionLabel(p, presetSizes),
              }))}
              onChange={(preset) => void handleChangeDownloadQuality(preset)}
              buttonClassName="cursor-pointer bg-ink-800 text-[11px] font-medium text-gray-300"
            />
          )}
        </span>
      )}
    </>
  );
}
