import { useMemo, useState } from "react";
import { api } from "../../api";
import { useToast } from "../../context/ToastContext";
import { useChannels } from "../../queries/videos";
import type { AllowedChannel, UserAccount } from "../../types";
import { PANEL_BTN } from "../settings/constants";
import { Toggle } from "../settings/ui";

const key = (c: AllowedChannel) => (c.url || c.name || "").trim().toLowerCase();

/**
 * Parental controls for one member: when on, they see and play only the
 * chosen library channels (the server enforces it everywhere), cannot search
 * YouTube, and keep only offline saving of what they may watch.
 */
export default function ParentalControls({
  user,
  onChanged,
}: {
  user: UserAccount;
  onChanged: () => Promise<void>;
}) {
  const { showToast, showError } = useToast();
  const channels = useChannels("alphabetical", "asc").data;
  const [on, setOn] = useState(user.allowed_channels != null);
  const [picked, setPicked] = useState<AllowedChannel[]>(
    user.allowed_channels ?? []
  );
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  // The library's channels, plus any chosen one no longer in it.
  const options = useMemo(() => {
    const list: AllowedChannel[] = (channels ?? []).map((c) => ({
      url: c.channel_url ?? null,
      name: c.channel,
    }));
    const known = new Set(list.map(key));
    for (const c of picked) if (!known.has(key(c))) list.push(c);
    return list;
  }, [channels, picked]);
  const chosen = new Set(picked.map(key));
  const q = filter.trim().toLowerCase();
  const shown = q
    ? options.filter((c) => (c.name ?? c.url ?? "").toLowerCase().includes(q))
    : options;

  const save = async (next: AllowedChannel[] | null, done: string) => {
    setBusy(true);
    try {
      await api.setAllowedChannels(user.id, next);
      showToast(done);
      await onChanged();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={`Parental controls for ${user.username}`}
      data-horde="parental-controls"
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-200">Parental controls</p>
          <p className="text-xs text-muted">
            Only let {user.username} watch the channels chosen below. Everything
            else (other channels, YouTube search, downloads, Ask) is turned off
            for them, not just hidden.
          </p>
        </div>
        <Toggle
          checked={on}
          label={`Limit ${user.username} to chosen channels`}
          disabled={busy}
          onChange={() => {
            if (on && user.allowed_channels != null) {
              setOn(false);
              void save(null, `${user.username} can watch every channel again`);
              return;
            }
            setOn(!on);
          }}
        />
      </div>
      {on && (
        <>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a channel"
            aria-label="Find a channel"
            className="w-full max-w-sm rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm text-gray-100 outline-hidden focus:border-accent"
          />
          <ul
            aria-label="Channels they may watch"
            className="horde-scrollbar max-h-60 max-w-sm space-y-0.5 overflow-y-auto rounded-lg border border-ink-700 p-1"
          >
            {shown.map((c) => {
              const id = key(c);
              const checked = chosen.has(id);
              return (
                <li key={id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-gray-200 hover:bg-ink-800">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setPicked((prev) =>
                          checked
                            ? prev.filter((p) => key(p) !== id)
                            : [...prev, c]
                        )
                      }
                    />
                    <span className="truncate">{c.name ?? c.url}</span>
                  </label>
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted">
                No channels in the library match.
              </li>
            )}
          </ul>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={PANEL_BTN}
              disabled={busy}
              onClick={() =>
                void save(
                  picked,
                  `${user.username} can watch ${picked.length} ${
                    picked.length === 1 ? "channel" : "channels"
                  }`
                )
              }
            >
              Save allowed channels
            </button>
            <span className="text-xs text-muted">{picked.length} chosen</span>
          </div>
        </>
      )}
    </section>
  );
}
