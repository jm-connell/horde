import { useCallback, useEffect, useRef, useState } from "react";
import { formatDuration } from "../utils";

export type ViewMode = "standard" | "theater" | "windowed";

interface Props {
  src: string;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
}

export default function VideoPlayer({ src, mode, onModeChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const toggleTheater = useCallback(() => {
    onModeChange(mode === "theater" ? "standard" : "theater");
  }, [mode, onModeChange]);

  const toggleWindowed = useCallback(() => {
    onModeChange(mode === "windowed" ? "standard" : "windowed");
  }, [mode, onModeChange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "t") {
        toggleTheater();
      } else if (e.key === "f") {
        toggleWindowed();
      } else if (e.key === "Escape" && mode === "windowed") {
        onModeChange("standard");
      } else if (e.key === "ArrowRight" && videoRef.current) {
        videoRef.current.currentTime += 5;
      } else if (e.key === "ArrowLeft" && videoRef.current) {
        videoRef.current.currentTime -= 5;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, toggleTheater, toggleWindowed, mode, onModeChange]);

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Number(e.target.value);
  };

  const onVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    setVolume(value);
    setMuted(value === 0);
    if (videoRef.current) {
      videoRef.current.volume = value;
      videoRef.current.muted = value === 0;
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const progressPct = duration > 0 ? (current / duration) * 100 : 0;

  const wrapperClass =
    mode === "windowed"
      ? "fixed inset-0 z-50 flex items-center justify-center bg-black"
      : "relative w-full bg-black";

  return (
    <div className={wrapperClass}>
      <div className={mode === "windowed" ? "relative h-full w-full" : "relative"}>
        <video
          ref={videoRef}
          src={src}
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          className={
            mode === "windowed"
              ? "h-full w-full object-contain"
              : "aspect-video w-full bg-black"
          }
        />

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-4 pb-3 pt-10">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={current}
            onChange={onSeek}
            className="accent-scrubber w-full"
            style={{
              background: `linear-gradient(to right, #22d3ee ${progressPct}%, #2a313f ${progressPct}%)`,
            }}
          />
          <div className="mt-2 flex items-center gap-3 text-gray-100">
            <button onClick={togglePlay} className="text-xl leading-none hover:text-accent">
              {playing ? "❚❚" : "►"}
            </button>

            <div className="flex items-center gap-2">
              <button onClick={toggleMute} className="hover:text-accent">
                {muted || volume === 0 ? "🔇" : "🔊"}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={onVolume}
                className="accent-scrubber w-20"
              />
            </div>

            <span className="text-xs tabular-nums text-gray-300">
              {formatDuration(current)} / {formatDuration(duration)}
            </span>

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={toggleTheater}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  mode === "theater"
                    ? "bg-accent text-ink-950"
                    : "bg-ink-700 text-gray-200 hover:text-accent"
                }`}
                title="Theater mode (t)"
              >
                Theater
              </button>
              <button
                onClick={toggleWindowed}
                className={`rounded px-2 py-1 text-xs font-medium ${
                  mode === "windowed"
                    ? "bg-accent text-ink-950"
                    : "bg-ink-700 text-gray-200 hover:text-accent"
                }`}
                title="Windowed fullscreen (f)"
              >
                {mode === "windowed" ? "Exit" : "Fullscreen"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
