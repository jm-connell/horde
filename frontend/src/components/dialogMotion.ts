/**
 * Modal entrance (DESIGN.md "Motion"). The backdrop fades its color, not its
 * opacity: an ancestor below full opacity would drop the panel's backdrop
 * blur until the fade ends. Exits stay instant so nothing waits on them.
 */
export const DIALOG_BACKDROP_ENTER =
  "transition-colors duration-200 ease-fluid starting:bg-transparent";

export const DIALOG_PANEL_ENTER =
  "transition-[opacity,scale] duration-200 ease-fluid starting:scale-[0.97] starting:opacity-0 motion-reduce:starting:scale-100";
