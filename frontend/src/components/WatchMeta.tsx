import { useState } from "react";
import { Link } from "react-router-dom";
import ChaptersList from "./ChaptersList";
import Collapse from "./Collapse";
import LinkifiedText from "./LinkifiedText";
import { useSettings } from "../hooks/useSettings";
import type { Chapter } from "../utils";

export type WatchMetaProps = {
  description: string | null | undefined;
  chapters: Chapter[];
  /** When true, side-by-side layout is suppressed (e.g. queue sidebar visible). */
  queueVisible?: boolean;
  /** Library-only: personal notes. */
  notes?: string | null;
  /** Library-only: combined tags list. */
  tags?: string[];
  aiTags?: string[];
  userTags?: string[];
  onAddTag?: (tag: string) => Promise<void> | void;
  onRemoveTag?: (tag: string) => Promise<void> | void;
  onTagError?: (message: string) => void;
};

/**
 * Shared description + chapters chrome for library and streamed watch pages.
 * Description text is clipped until the corner expand control; tags/notes
 * sit at the end of that text. Side-by-side, chapters fill the description
 * height and only scroll if they still overflow.
 */
export default function WatchMeta({
  description,
  chapters,
  queueVisible = false,
  notes = null,
  tags = [],
  aiTags = [],
  userTags = [],
  onAddTag,
  onRemoveTag,
  onTagError,
}: WatchMetaProps) {
  const [settings, updateSettings] = useSettings();
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [boxExpanded, setBoxExpanded] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  const descriptionBody = (description ?? "").trim() ? description : null;
  const hasTags = tags.length > 0 || aiTags.length > 0 || userTags.length > 0;
  const showLibraryExtras = !!(notes || hasTags);
  const showDescriptionText = settings.showDescription && !!descriptionBody;
  const showDescriptionPanel =
    settings.showDescription && !!(descriptionBody || showLibraryExtras);
  const metaSideBySide =
    chapters.length > 0 && showDescriptionPanel && !queueVisible;
  const hasExtras = !!(notes || hasTags || onAddTag);
  const extrasLabel = hasTags || onAddTag ? "tags" : "notes";

  if (!showDescriptionPanel && chapters.length === 0) {
    if (!settings.showDescription && notes) {
      return (
        <div className="ui-panel rounded-xl border border-accent/30 bg-accent/5 p-4 ring-1 ring-ink-700">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">
            Your notes
          </h3>
          <p className="whitespace-pre-wrap text-sm text-gray-300">
            <LinkifiedText text={notes} />
          </p>
        </div>
      );
    }
    return null;
  }

  const tagItems = [
    ...aiTags.map((t) => ({ tag: t, kind: "ai" as const })),
    ...userTags.map((t) => ({ tag: t, kind: "user" as const })),
    ...tags
      .filter((t) => {
        const lower = t.toLowerCase();
        return (
          !aiTags.some((a) => a.toLowerCase() === lower) &&
          !userTags.some((u) => u.toLowerCase() === lower)
        );
      })
      .map((t) => ({ tag: t, kind: "meta" as const })),
  ];

  const extrasBlock = (
    <>
      {descriptionBody && hasExtras && (
        <button
          type="button"
          onClick={() => setExtrasOpen((v) => !v)}
          className="ui-panel-toggle ui-interactive mt-2 shrink-0 text-xs font-medium text-accent outline-none focus:outline-none"
        >
          <span className="ui-panel-toggle-press inline-flex transition-transform">
            {extrasOpen ? `Hide ${extrasLabel}` : `Show ${extrasLabel}`}
          </span>
        </button>
      )}
      {notes && (
        <Collapse open={extrasOpen || !descriptionBody}>
          <div
            className={
              descriptionBody ? "mt-4 border-t border-ink-700 pt-4" : ""
            }
          >
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent">
              Your notes
            </h3>
            <p className="whitespace-pre-wrap text-sm text-gray-300">
              <LinkifiedText text={notes} />
            </p>
          </div>
        </Collapse>
      )}
      {(hasTags || onAddTag) && (
        <Collapse open={extrasOpen || !descriptionBody}>
          <div
            className={
              descriptionBody || notes
                ? "mt-4 border-t border-ink-700 pt-4"
                : ""
            }
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {tagItems.map(({ tag, kind }) => (
                <span
                  key={`${kind}-${tag}`}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${
                    kind === "ai"
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : kind === "user"
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                        : "ui-panel border-ink-700 bg-ink-900 text-gray-300"
                  }`}
                  title={
                    kind === "ai"
                      ? "AI tag"
                      : kind === "user"
                        ? "Your tag"
                        : "Metadata tag"
                  }
                >
                  <Link
                    to={`/?tag=${encodeURIComponent(tag)}`}
                    className="hover:underline"
                  >
                    #{tag}
                  </Link>
                  {onRemoveTag && (
                    <button
                      type="button"
                      className="ml-0.5 text-[10px] opacity-60 hover:opacity-100"
                      title="Remove tag"
                      onClick={() => {
                        void Promise.resolve(onRemoveTag(tag)).catch(() =>
                          onTagError?.("Could not remove tag")
                        );
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {onAddTag && (
                <form
                  className="inline-flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const cleaned = tagDraft.trim();
                    if (!cleaned) return;
                    const exists = tags.some(
                      (t) => t.toLowerCase() === cleaned.toLowerCase()
                    );
                    if (exists) {
                      setTagDraft("");
                      return;
                    }
                    void Promise.resolve(onAddTag(cleaned))
                      .then(() => setTagDraft(""))
                      .catch(() => onTagError?.("Could not add tag"));
                  }}
                >
                  <input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    placeholder="Add tag…"
                    className="ui-panel w-28 max-w-[9rem] rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-100 outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
                  >
                    +
                  </button>
                </form>
              )}
            </div>
          </div>
        </Collapse>
      )}
    </>
  );

  const metaBody = (
        <div
          className={
            metaSideBySide
              ? "grid gap-4 lg:grid-cols-[minmax(0,1.75fr)_minmax(12rem,0.85fr)] lg:items-stretch"
              : undefined
          }
        >
          {showDescriptionPanel && (
            <div
              className={
                metaSideBySide
                  ? "ui-panel isolate relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700"
                  : "ui-panel isolate relative min-h-0 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700"
              }
            >
              {descriptionBody && (
                <div className="relative min-h-0">
                  <div
                    className={
                      boxExpanded
                        ? metaSideBySide
                          ? "overflow-visible"
                          : "overflow-hidden transition-[max-height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] max-h-[80rem]"
                        : metaSideBySide
                          ? "horde-meta-scrollbar max-h-48 overflow-y-auto"
                          : "overflow-hidden transition-[max-height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] max-h-[7.5rem]"
                    }
                  >
                    <div className="px-4 py-3 pr-8">
                      <p
                        className={`text-sm text-gray-300 ${
                          boxExpanded || metaSideBySide
                            ? "whitespace-pre-wrap"
                            : "line-clamp-5 whitespace-normal"
                        }`}
                      >
                        <LinkifiedText text={descriptionBody} />
                      </p>
                      {metaSideBySide && extrasBlock}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBoxExpanded((v) => !v)}
                    className="absolute bottom-2 right-2 z-[1] flex h-5 w-5 items-center justify-center rounded text-gray-500/55 hover:text-accent"
                    title={
                      boxExpanded
                        ? "Collapse description"
                        : "Expand description"
                    }
                    aria-label={
                      boxExpanded
                        ? "Collapse description"
                        : "Expand description"
                    }
                    aria-expanded={boxExpanded}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={`h-3.5 w-3.5 transition-transform ${
                        boxExpanded ? "rotate-180" : ""
                      }`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                </div>
              )}
              {(!descriptionBody || !metaSideBySide) && hasExtras && (
                <div className={descriptionBody ? "px-4 pb-3" : "px-4 py-3"}>
                  {extrasBlock}
                </div>
              )}
            </div>
          )}
          {chapters.length > 0 && (
            <div
              className={
                metaSideBySide ? "relative min-h-0 lg:min-h-0" : undefined
              }
            >
              <div
                className={
                  metaSideBySide ? "lg:absolute lg:inset-0" : undefined
                }
              >
                <ChaptersList
                  chapters={chapters}
                  className={metaSideBySide ? "lg:h-full" : undefined}
                  maxHeightClass={
                    metaSideBySide
                      ? "max-h-48 lg:h-full lg:max-h-none"
                      : "max-h-48"
                  }
                />
              </div>
            </div>
          )}
        </div>
  );

  if (!showDescriptionText) {
    return <div>{metaBody}</div>;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          updateSettings({
            descriptionExpanded: !settings.descriptionExpanded,
          })
        }
        className="ui-panel-toggle ui-interactive flex w-full items-center justify-between py-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
      >
        <span className="ui-panel-toggle-press inline-flex items-center gap-2 transition-transform">
          <span>Description</span>
          <span>{settings.descriptionExpanded ? "▲" : "▼"}</span>
        </span>
      </button>
      <Collapse open={settings.descriptionExpanded}>
        {metaBody}
      </Collapse>
    </div>
  );
}
