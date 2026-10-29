import { useEffect, useState } from "react";
import { api } from "../../api";
import { button } from "../../components/buttons";
import { useToast } from "../../context/ToastContext";
import type { RecFeedback } from "../../types";

const KIND_LABEL: Record<string, string> = {
  video: "Video",
  channel: "Channel",
  suggestion: "Suggestion",
};

/** What you asked Recommended+ to leave out, and a way to take it back. */
export default function RecommendationsSection() {
  const { showError } = useToast();
  const [items, setItems] = useState<RecFeedback[] | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listRecFeedback()
      .then((data) => {
        if (active) setItems(data.items);
      })
      .catch(() => {
        if (active) setItems([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const remove = (row: RecFeedback) => {
    setItems((prev) => prev?.filter((r) => r.id !== row.id) ?? null);
    api.removeRecFeedback(row.id).catch(() => {
      showError("Could not undo that");
      setItems((prev) => (prev ? [row, ...prev] : [row]));
    });
  };

  return (
    <section aria-labelledby="recs-heading">
      <h2
        id="recs-heading"
        className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400"
      >
        Hidden from recommendations
      </h2>
      {items === null ? null : items.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing hidden. Use the menu on a Recommended+ card to hide a video or
          a channel.
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-ink-800"
            >
              <span className="w-20 shrink-0 text-xs text-muted">
                {KIND_LABEL[row.kind] ?? row.kind}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                {row.label || row.key}
              </span>
              <button
                type="button"
                onClick={() => remove(row)}
                className={button("quiet", "xs")}
                aria-label={`Show ${row.label || row.key} again`}
              >
                Show again
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
