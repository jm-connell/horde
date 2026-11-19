/**
 * The grid of video cards (library, search results, channel feed,
 * Recommended): one column on phones, then as many as fit the space the grid
 * actually has, at most five (four beside the open channel sidebar). The
 * columns follow the grid's own width, not the window's (`.video-grid` in
 * index.css), so cards keep their size when the chat is docked beside the page.
 */
export function videoGridClassName(sidebarCollapsed: boolean): string {
  return `video-grid grid grid-cols-1 gap-4 max-sm:gap-0 max-sm:-mx-3 ${
    sidebarCollapsed ? "[--video-grid-max:5]" : "[--video-grid-max:4]"
  }`;
}
