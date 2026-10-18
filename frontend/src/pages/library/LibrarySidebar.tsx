import ChannelSidebar from "../../components/ChannelSidebar";
import type { ChannelStat } from "../../types";
import type { Settings } from "../../hooks/useSettings";

type SidebarProps = React.ComponentProps<typeof ChannelSidebar>;

/** The channel rail beside the library, and its overlay on narrow screens. */
export default function LibrarySidebar({
  channels,
  activeChannel,
  channelSort,
  sidebarCollapsed,
  narrowViewport,
  overlayOpen,
  overlayVisible,
  showAllChannels,
  onToggleShowAll,
  onSelectChannel,
  onSelectRemoteChannel,
  onOpen,
  onClose,
}: {
  channels: ChannelStat[];
  activeChannel: string | null;
  channelSort: Settings["channelSort"];
  sidebarCollapsed: boolean;
  narrowViewport: boolean;
  overlayOpen: boolean;
  overlayVisible: boolean;
  showAllChannels: boolean;
  onToggleShowAll: () => void;
  onSelectChannel: SidebarProps["onSelectChannel"];
  onSelectRemoteChannel: SidebarProps["onSelectRemoteChannel"];
  onOpen: () => void;
  onClose: () => void;
}) {
  const sidebar = (
    <ChannelSidebar
      channels={channels}
      activeChannel={activeChannel}
      channelSort={channelSort}
      showAllChannels={showAllChannels}
      onSelectChannel={onSelectChannel}
      onSelectRemoteChannel={onSelectRemoteChannel}
      onToggleShowAll={onToggleShowAll}
    />
  );
  return (
    <>
      {/* Narrow: fixed overlay channel panel — toggle stays on the sticky rail */}
      {narrowViewport && overlayVisible && (
        <div className="fixed inset-0 z-50 hidden md:block">
          <button
            type="button"
            aria-label="Close channels"
            className={`absolute inset-0 bg-ink-950/60 backdrop-blur-xs transition-opacity duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              overlayOpen ? "opacity-100" : "opacity-0"
            }`}
            onClick={onClose}
          />
          <div
            className={`absolute top-0 flex h-full max-w-[85vw] flex-col p-3 pt-20 left-3 pl-12 md:left-6 md:pl-13 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              // Clear left-3 / md:left-6 so the panel fully exits the viewport.
              overlayOpen
                ? "translate-x-0"
                : "-translate-x-[calc(100%+0.75rem)] md:-translate-x-[calc(100%+1.5rem)]"
            }`}
          >
            <div className="ui-panel ui-panel-legible flex max-h-full w-56 flex-col overflow-hidden rounded-xl bg-ink-900 p-2 ring-1 ring-ink-700">
              <div className="mb-2 flex shrink-0 items-center px-2 pt-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Channels
                </h2>
              </div>
              <div className="min-h-0 overflow-y-auto">{sidebar}</div>
            </div>
          </div>
        </div>
      )}

      <aside
        data-horde="sidebar"
        className={`relative hidden shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:block ${
          narrowViewport || sidebarCollapsed ? "w-10" : "w-56"
        }${narrowViewport && overlayOpen ? " z-60" : ""}`}
      >
        <div className="sticky top-20">
          {!narrowViewport && !sidebarCollapsed ? (
            <div className="ui-panel h-fit w-56 rounded-xl bg-ink-900 p-2 ring-1 ring-ink-700">
              <div className="mb-2 flex items-center gap-1 px-2 pt-1">
                <button
                  onClick={onClose}
                  title="Collapse sidebar"
                  className="ui-interactive flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base text-muted hover:bg-ink-800 hover:text-accent"
                >
                  ‹
                </button>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Channels
                </h2>
              </div>
              {sidebar}
            </div>
          ) : (
            <button
              onClick={narrowViewport && overlayOpen ? onClose : onOpen}
              title={
                narrowViewport && overlayOpen
                  ? "Collapse sidebar"
                  : "Expand channels"
              }
              className="ui-panel ui-interactive flex h-8 w-8 items-center justify-center rounded-md text-base text-muted ring-1 ring-ink-700 hover:bg-ink-800 hover:text-accent"
            >
              {narrowViewport && overlayOpen ? "‹" : "›"}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
