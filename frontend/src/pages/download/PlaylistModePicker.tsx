export type PlaylistMode = "subscribe" | "import" | "videos";

/** The three things a pasted playlist link can become. */
export default function PlaylistModePicker({
  playlistMode,
  onChange,
}: {
  playlistMode: PlaylistMode;
  onChange: (mode: PlaylistMode) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-gray-300">Playlist action</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {(
          [
            [
              "import",
              "Import playlist",
              "One-time download of the videos, saved as a playlist in Horde.",
            ],
            [
              "subscribe",
              "Subscribe",
              "Sync with the YouTube playlist and download new videos as they appear.",
            ],
            [
              "videos",
              "Download videos",
              "Download them like regular videos, without organizing into a playlist.",
            ],
          ] as const
        ).map(([mode, label, hint]) => (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
              playlistMode === mode
                ? "border-accent bg-accent/15 text-accent"
                : "border-ink-700 bg-ink-950 text-gray-300 hover:border-ink-600"
            }`}
          >
            <span className="block text-sm font-medium">{label}</span>
            <span
              className={`mt-1 block text-xs font-normal leading-relaxed ${
                playlistMode === mode ? "text-accent/80" : "text-muted"
              }`}
            >
              {hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
