import Collapse from "../../components/Collapse";
import type { TagStat } from "../../types";
import { CloseIcon } from "../../components/icons";

/**
 * The tag chips under the header: the open tag's clear chip (tag pages), the
 * show/hide button for narrow tag pages, and the collapsible list of tags.
 */
export default function TagDrawer({
  activeTag,
  isHome,
  onChannelPage,
  hasTags,
  showTags,
  visibleTags,
  hiddenTagCount,
  onToggleTags,
  onSelectTag,
  onShowAllTags,
}: {
  activeTag: string | null;
  isHome: boolean;
  onChannelPage: boolean;
  hasTags: boolean;
  showTags: boolean;
  visibleTags: TagStat[];
  hiddenTagCount: number;
  onToggleTags: () => void;
  onSelectTag: (tag: string | null) => void;
  onShowAllTags: () => void;
}) {
  return (
    <div>
      {!isHome && !onChannelPage && (activeTag || hasTags) && (
        <div
          className={`flex flex-wrap items-center gap-2 transition-[margin] duration-300 ease-fluid motion-reduce:transition-none ${
            showTags && hasTags ? "mb-2" : "mb-5"
          }`}
        >
          {activeTag && (
            <button
              onClick={() => onSelectTag(null)}
              aria-label={`Clear tag #${activeTag}`}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-medium text-on-accent"
            >
              #{activeTag} <CloseIcon />
            </button>
          )}
          {hasTags && (
            <button
              onClick={onToggleTags}
              className="ui-panel ui-interactive hidden rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-gray-300 hover:border-accent hover:text-accent lg:inline-block"
            >
              {showTags ? "Hide tags" : "Show tags"}
            </button>
          )}
        </div>
      )}
      {hasTags && (
        <Collapse open={showTags} className="motion-reduce:transition-none">
          <div
            className={`mb-5 flex flex-wrap items-center gap-2 transition-transform duration-300 ease-fluid motion-reduce:transition-none ${
              showTags ? "translate-y-0" : "pointer-events-none -translate-y-1"
            }`}
            aria-hidden={!showTags}
          >
            {visibleTags
              .filter((t) => t.tag !== activeTag)
              .map((t) => (
                <button
                  key={t.tag}
                  onClick={() => onSelectTag(t.tag)}
                  tabIndex={showTags ? 0 : -1}
                  className="ui-panel ui-interactive rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
                >
                  #{t.tag}
                  <span className="ml-1.5 text-muted">{t.count}</span>
                </button>
              ))}
            {hiddenTagCount > 0 && (
              <button
                onClick={onShowAllTags}
                tabIndex={showTags ? 0 : -1}
                className="ui-panel ui-interactive rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-gray-400 hover:border-accent hover:text-accent"
              >
                Show more ({hiddenTagCount})
              </button>
            )}
          </div>
        </Collapse>
      )}
    </div>
  );
}
