export function videoGridClassName(sidebarCollapsed: boolean): string {
  return `grid grid-cols-1 gap-4 max-sm:gap-0 max-sm:-mx-3 sm:grid-cols-2 md:grid-cols-3 ${
    sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
  }`;
}
