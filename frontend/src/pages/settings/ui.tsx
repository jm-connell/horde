import { CHIP, CHIP_ACTIVE, PANEL_BTN } from "./constants";

export function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onChange}
      className={`ui-interactive flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-accent" : "bg-ink-700"
      }`}
    >
      <span
        className={`block h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function SettingRow({
  title,
  description,
  control,
  hidden = false,
}: {
  title: string;
  description?: string;
  control: React.ReactNode;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="block text-sm font-medium text-gray-200">{title}</span>
        {description && (
          <span className="block text-xs text-gray-500">{description}</span>
        )}
      </span>
      {control}
    </label>
  );
}

export function ProcessActionRow({
  label,
  description,
  busy,
  disabled,
  onClick,
  heavy = false,
}: {
  label: string;
  description: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  heavy?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-200">
          {label}
          {heavy && (
            <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400 align-middle">
              Heavy
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">{description}</p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={`${PANEL_BTN} shrink-0`}
      >
        {busy ? "Queuing…" : "Queue"}
      </button>
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  first = false,
  hidden = false,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  first?: boolean;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div className={first ? undefined : "border-t border-ink-700 pt-6"}>
      {title ? (
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
          {title}
        </h2>
      ) : null}
      {description && (
        <p className={`mb-3 text-xs text-gray-500 ${title ? "" : "mt-0"}`}>
          {description}
        </p>
      )}
      <div className={title || description ? undefined : "mt-0"}>{children}</div>
    </div>
  );
}

export function Chip({
  active,
  onClick,
  onPointerDown,
  children,
  className = "",
  title,
  "aria-label": ariaLabel,
}: {
  active: boolean;
  onClick?: () => void;
  onPointerDown?: () => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      onPointerDown={
        onPointerDown
          ? (e) => {
              e.preventDefault();
              onPointerDown();
            }
          : undefined
      }
      className={`${active ? CHIP_ACTIVE : CHIP} ${className}`}
    >
      {children}
    </button>
  );
}
