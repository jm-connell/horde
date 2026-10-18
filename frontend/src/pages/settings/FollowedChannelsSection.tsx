import { useState } from "react";
import {
  useFollowMutation,
  useFollows,
  useUnfollowMutation,
} from "../../queries/follows";
import { INPUT_COMPACT, PANEL_BTN } from "./constants";

/** Collapsed list of followed channels with unfollow and a follow-by-URL form. */
export default function FollowedChannelsSection() {
  const { follows } = useFollows();
  const follow = useFollowMutation();
  const unfollow = useUnfollowMutation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const url = value.trim();
    if (!url) return;
    setError(null);
    try {
      await follow.mutateAsync({ url });
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not follow channel");
    }
  };

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted hover:text-gray-300"
      >
        {open ? "▾" : "▸"} Followed channels ({follows.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {follows.length > 0 && (
            <ul className="space-y-1">
              {follows.map((f) => (
                <li
                  key={f.channel_url}
                  className="flex items-center justify-between gap-3 text-sm text-gray-300"
                >
                  <span className="truncate" title={f.channel_url}>
                    {f.channel_name || f.channel_url}
                  </span>
                  <button
                    type="button"
                    disabled={unfollow.isPending}
                    onClick={() => unfollow.mutate(f.channel_url)}
                    className="shrink-0 text-xs text-muted hover:text-accent disabled:opacity-50"
                  >
                    Unfollow
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              type="text"
              aria-label="Channel URL or @handle"
              placeholder="Channel URL or @handle"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className={`${INPUT_COMPACT} w-56!`}
            />
            <button
              type="submit"
              disabled={follow.isPending || !value.trim()}
              className={PANEL_BTN}
            >
              Follow
            </button>
          </form>
          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
