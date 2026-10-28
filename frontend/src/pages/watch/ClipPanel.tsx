import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { usePlaybackActions } from "../../context/PlaybackContext";
import { useToast } from "../../context/ToastContext";
import { formatTimestamp } from "../../utils";
import {
  clipLength,
  clipRequest,
  liveMark,
  parseClock,
  type ClipMark,
} from "./clipRange";
import { button } from "../../components/buttons";

const FIELD =
  "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent";
const SECONDARY =
  "shrink-0 rounded-lg border border-ink-600 px-3 py-2 text-xs text-gray-300 hover:border-accent hover:text-accent";

function markLabel(mark: ClipMark): string {
  return mark.kind === "live"
    ? new Date(mark.atMs).toLocaleTimeString()
    : formatTimestamp(mark.sec);
}

/**
 * One end of the clip: the time it is set to and a button to take the
 * playhead's. The typed text is its own: the parent remounts the field (a new
 * `key`) when the button sets the time, so typing is never rewritten.
 */
function MarkField({
  label,
  mark,
  live,
  focusOnMount = false,
  onChange,
  onUseCurrent,
}: {
  label: string;
  /** Null while the typed text is not a time. */
  mark: ClipMark | null;
  live: boolean;
  focusOnMount?: boolean;
  onChange: (mark: ClipMark | null) => void;
  onUseCurrent: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => (mark ? markLabel(mark) : ""));
  useEffect(() => {
    // The page scrolls up to the player itself: focus without jumping.
    if (focusOnMount) inputRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="mb-1 block text-sm text-gray-300">
        {label}
      </label>
      <div className="flex items-center gap-2">
        {live ? (
          <output
            id={id}
            className="flex-1 py-2 text-sm text-gray-100 tabular-nums"
          >
            {mark ? markLabel(mark) : "–"}
          </output>
        ) : (
          <input
            ref={inputRef}
            id={id}
            value={text}
            inputMode="numeric"
            placeholder="h:mm:ss"
            onChange={(e) => {
              setText(e.target.value);
              const sec = parseClock(e.target.value);
              onChange(sec == null ? null : { kind: "time", sec });
            }}
            className={`${FIELD} flex-1 tabular-nums`}
          />
        )}
        <button type="button" onClick={onUseCurrent} className={SECONDARY}>
          Use current time
        </button>
      </div>
    </div>
  );
}

/**
 * Pick the start and end of a clip of the playing stream, right under the
 * player so the video stays in view, and queue it. The picked range is drawn
 * on the seek bar while the panel is open; playback is never moved.
 */
export default function ClipPanel({
  url,
  title,
  live,
  library = false,
  onClose,
}: {
  url: string;
  title: string | null;
  live: boolean;
  /** A downloaded video: "current time" is the library player's position. */
  library?: boolean;
  onClose: () => void;
}) {
  const {
    getStreamPosition,
    getCurrentPosition,
    getStreamBehindLive,
    setClipMarkers,
  } = usePlaybackActions();
  const { showToast, showError } = useToast();
  const headingId = useId();

  const current = (): ClipMark =>
    live
      ? liveMark(getStreamBehindLive() ?? 0, Date.now())
      : {
          kind: "time",
          sec: Math.floor(library ? getCurrentPosition() : getStreamPosition()),
        };
  const back = (mark: ClipMark): ClipMark =>
    mark.kind === "live"
      ? { kind: "live", atMs: mark.atMs - 60_000 }
      : { kind: "time", sec: Math.max(0, mark.sec - 60) };

  // Start with the minute before the playhead.
  const [end, setEnd] = useState<ClipMark | null>(current);
  const [start, setStart] = useState<ClipMark | null>(() =>
    end ? back(end) : null
  );
  // Bumped when "Use current time" sets an end, to show its new time.
  const [startRev, setStartRev] = useState(0);
  const [endRev, setEndRev] = useState(0);
  const [busy, setBusy] = useState(false);
  const length = start && end ? clipLength(start, end) : NaN;
  const valid = Number.isFinite(length) && length >= 1;

  // Dragging an end on the seek bar moves it here too (and shows its time).
  const onMove = useCallback((which: "start" | "end", mark: ClipMark) => {
    if (which === "start") {
      setStart(mark);
      setStartRev((n) => n + 1);
    } else {
      setEnd(mark);
      setEndRev((n) => n + 1);
    }
  }, []);
  useEffect(() => {
    setClipMarkers({ start, end, onMove });
  }, [start, end, onMove, setClipMarkers]);
  useEffect(() => () => setClipMarkers(null), [setClipMarkers]);

  const save = async () => {
    if (!start || !end || !valid || busy) return;
    setBusy(true);
    try {
      await api.createClip(clipRequest(url, title, start, end, Date.now()));
      showToast("Clip queued. It appears in your library when it’s ready.");
      onClose();
    } catch (err) {
      setBusy(false);
      showError(
        err instanceof Error ? err.message : "Could not queue the clip"
      );
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="ui-panel mt-4 rounded-xl bg-ink-900 p-4 ring-1 ring-ink-700"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-gray-100">
          Save a clip
        </h2>
        <p className="text-xs text-muted">
          {live
            ? "Take each end from the player, or drag the marks on the seek bar."
            : "Type the times, take them from the player, or drag the marks on the seek bar."}
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <MarkField
            key={`start-${startRev}`}
            label="Start"
            mark={start}
            live={live}
            focusOnMount={startRev === 0}
            onChange={setStart}
            onUseCurrent={() => {
              setStart(current());
              setStartRev((n) => n + 1);
            }}
          />
          <MarkField
            key={`end-${endRev}`}
            label="End"
            mark={end}
            live={live}
            onChange={setEnd}
            onUseCurrent={() => {
              setEnd(current());
              setEndRev((n) => n + 1);
            }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted" aria-live="polite">
            {valid
              ? `Length ${formatTimestamp(length)} · progress on the `
              : start && end
                ? "The end has to come at least a second after the start."
                : "Enter times as h:mm:ss."}
            {valid && (
              <Link to="/download" className="underline">
                Download
              </Link>
            )}
            {valid && " page"}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-300 hover:text-gray-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || busy}
              className={button("primary")}
            >
              {busy ? "Queuing…" : "Save clip"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
