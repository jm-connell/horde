import { useId } from "react";

/**
 * A checklist with Select all / Deselect all. `locked` items (nothing to do:
 * already followed, already imported) show but cannot be picked.
 */
export default function TakeoutChoiceList<T>({
  title,
  description,
  items,
  itemKey,
  label,
  note,
  locked,
  selected,
  onChange,
}: {
  title: string;
  description: string;
  items: T[];
  itemKey: (item: T) => string;
  label: (item: T) => string;
  note: (item: T) => string | null;
  locked: (item: T) => boolean;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const headingId = useId();
  const open = items.filter((item) => !locked(item));
  const chosen = open.filter((item) => selected.has(itemKey(item))).length;

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={headingId} className="text-sm font-semibold text-gray-200">
          {title}{" "}
          <span className="font-normal text-muted">
            ({chosen.toLocaleString()} of {open.length.toLocaleString()}{" "}
            selected)
          </span>
        </h3>
        <span className="flex gap-3 text-xs">
          <button
            type="button"
            className="text-muted hover:text-accent disabled:opacity-50"
            aria-label={`Select all ${title.toLowerCase()}`}
            disabled={chosen === open.length}
            onClick={() => onChange(new Set(open.map(itemKey)))}
          >
            Select all
          </button>
          <button
            type="button"
            className="text-muted hover:text-accent disabled:opacity-50"
            aria-label={`Deselect all ${title.toLowerCase()}`}
            disabled={chosen === 0}
            onClick={() => onChange(new Set())}
          >
            Deselect all
          </button>
        </span>
      </div>
      <p className="mb-2 text-xs text-muted">{description}</p>
      <ul className="max-h-64 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 py-1">
        {items.map((item) => {
          const key = itemKey(item);
          const isLocked = locked(item);
          const extra = note(item);
          return (
            <li key={key}>
              <label
                className={`flex items-center gap-3 px-3 py-1.5 text-sm ${
                  isLocked
                    ? "cursor-default text-muted"
                    : "cursor-pointer text-gray-200 hover:bg-ink-800"
                }`}
              >
                <input
                  type="checkbox"
                  className="rounded-sm border-ink-600"
                  checked={isLocked || selected.has(key)}
                  disabled={isLocked}
                  onChange={() => toggle(key)}
                />
                <span className="min-w-0 flex-1 truncate">{label(item)}</span>
                {extra && (
                  <span className="shrink-0 text-xs text-muted">{extra}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
