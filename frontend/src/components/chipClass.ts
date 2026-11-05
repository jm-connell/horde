/** A filter chip on the home tabs (selected: the accent). */
export function chipClass(selected: boolean): string {
  return `ui-panel ui-interactive shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
    selected
      ? "border-accent bg-accent/10 text-accent"
      : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
  }`;
}
