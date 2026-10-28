import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { MenuFlyout } from "../../components/MenuFlyout";
import { usePlaybackActions } from "../../context/PlaybackContext";
import { useToast } from "../../context/ToastContext";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { formatTimestamp } from "../../utils";
import {
  clipLength,
  clipRequest,
  liveMark,
  parseClock,
  type ClipMark,
} from "./clipRange";

const FIELD =
  "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent";
const SECONDARY =
  "rounded-lg border border-ink-600 px-3 py-1.5 text-xs text-gray-300 hover:border-accent hover:text-accent";

function markLabel(mark: ClipMark): string {
  return mark.kind === "live"
    ? new Date(mark.atMs).toLocaleTimeString()
    : formatTimestamp(mark.sec);
}

/** One end of the clip: the time it is set to and a button to take the playhead's. */
function MarkField({
  label,
  mark,
  live,
  onChange,
  onUseCurrent,
}: {
  label: string;
  mark: ClipMark;
  live: boolean;
  onChange: (mark: ClipMark | null) => void;
  onUseCurrent: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(markLabel(mark));
  const [shown, setShown] = useState(mark);
  if (shown !== mark) {
    // The playhead button moved it: show the new time.
    setShown(mark);
    setText(markLabel(mark));
  }
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-sm text-gray-300">
        {label}
      </label>
      <div className="flex items-center gap-2">
        {live ? (
          <output id={id} className="flex-1 text-sm text-gray-100 tabular-nums">
            {markLabel(mark)}
          </output>
        ) : (
          <input
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

/** Pick the start and end of a clip of the playing stream and queue it. */
function ClipDialog({
  url,
  title,
  live,
  onClose,
}: {
  url: string;
  title: string | null;
  live: boolean;
  onClose: () => void;
}) {
  const { getStreamPosition, getStreamBehindLive } = usePlaybackActions();
  const { showToast, showError } = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { active: true, onEscape: onClose });

  const current = (): ClipMark =>
    live
      ? liveMark(getStreamBehindLive() ?? 0, Date.now())
      : { kind: "time", sec: Math.floor(getStreamPosition()) };
  const back = (mark: ClipMark): ClipMark =>
    mark.kind === "live"
      ? { kind: "live", atMs: mark.atMs - 60_000 }
      : { kind: "time", sec: Math.max(0, mark.sec - 60) };

  // Start with the minute before the playhead.
  const [end, setEnd] = useState<ClipMark | null>(current);
  const [start, setStart] = useState<ClipMark | null>(() =>
    end ? back(end) : null
  );
  const [busy, setBusy] = useState(false);
  const length = start && end ? clipLength(start, end) : NaN;
  const valid = Number.isFinite(length) && length >= 1;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clip-title"
        className="w-full max-w-md rounded-xl bg-ink-900 p-6 outline-hidden ring-1 ring-ink-700"
      >
        <h2
          id="clip-title"
          className="mb-1 text-lg font-semibold text-gray-100"
        >
          Save a clip
        </h2>
        <p className="mb-4 text-sm text-gray-400">
          {live
            ? "Play to where the clip should start or end and take the current time. You can go back as far as the player lets you scrub."
            : "Saved to your library as its own video."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {start && (
            <MarkField
              label="Start"
              mark={start}
              live={live}
              onChange={setStart}
              onUseCurrent={() => setStart(current())}
            />
          )}
          {end && (
            <MarkField
              label="End"
              mark={end}
              live={live}
              onChange={setEnd}
              onUseCurrent={() => setEnd(current())}
            />
          )}
          <p className="mb-5 text-xs text-muted" aria-live="polite">
            {valid
              ? `Length ${formatTimestamp(length)}`
              : "The end has to come at least a second after the start."}
          </p>
          <div className="flex justify-end gap-2">
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
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-soft disabled:opacity-50"
            >
              {busy ? "Queuing…" : "Save clip"}
            </button>
          </div>
        </form>
        <p className="mt-4 text-xs text-muted">
          Progress shows on the{" "}
          <Link to="/download" className="underline">
            Download
          </Link>{" "}
          page.
        </p>
      </div>
    </div>
  );
}

/** The ⋯ menu beside a live or past stream, holding "Save a clip…". */
export default function StreamClipControl({
  url,
  title,
  live,
}: {
  url: string;
  title: string | null;
  live: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="More stream actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className="rounded-lg border border-ink-600 px-2 py-1 text-xs leading-none text-gray-300 hover:border-accent hover:text-accent"
      >
        •••
      </button>
      <MenuFlyout
        open={menuOpen}
        className="absolute right-0 z-30 mt-1 min-w-40"
        menu={{
          label: "Stream actions",
          onClose: () => setMenuOpen(false),
          triggerRef,
        }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenuOpen(false);
            setDialogOpen(true);
          }}
          className="block w-full px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-ink-800"
        >
          Save a clip…
        </button>
      </MenuFlyout>
      {dialogOpen && (
        <ClipDialog
          url={url}
          title={title}
          live={live}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}
