/**
 * Button classes (DESIGN.md "Buttons"). One definition per variant so
 * buttons stay alike across pages; add layout classes (w-full, shrink-0,
 * margins) after it, never colors, padding or radius.
 *
 * - primary: the one main action on a view (accent fill).
 * - secondary: everything else (bordered panel, accent border on hover).
 * - quiet: low-emphasis text actions (Cancel beside a form, Skip).
 * - danger: destructive actions inside a page (outline).
 * - dangerSolid: the confirm button of a destructive dialog.
 */
export type ButtonVariant =
  "primary" | "secondary" | "quiet" | "danger" | "dangerSolid";

/** md: dialogs and forms; sm: settings rows and toolbars; xs: inline in lists. */
export type ButtonSize = "md" | "sm" | "xs";

const BASE =
  "ui-interactive rounded-lg disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent font-medium text-on-accent hover:bg-accent-soft",
  secondary:
    "ui-panel border border-ink-700 bg-ink-900 text-gray-200 hover:border-accent",
  quiet: "text-muted hover:text-accent",
  danger:
    "border border-danger/40 text-danger hover:border-danger hover:bg-danger/10",
  dangerSolid: "bg-red-600 font-medium text-white hover:bg-red-700",
};

const SIZE: Record<ButtonSize, string> = {
  md: "px-4 py-2 text-sm",
  sm: "px-3 py-1.5 text-sm",
  xs: "px-2.5 py-1 text-xs",
};

export function button(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md"
): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]}`;
}
