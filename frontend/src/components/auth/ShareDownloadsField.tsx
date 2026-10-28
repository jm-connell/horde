import { useId } from "react";

/**
 * One setting per account, applied on every device the account saves videos
 * to for offline viewing: on lets the other accounts on that device watch them;
 * off keeps them private to the account (its password unlocks them offline).
 */
export default function ShareDownloadsField({
  checked,
  onChange,
  disabled = false,
  own = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Your own account: "my downloads" rather than "this account's". */
  own?: boolean;
}) {
  const hintId = useId();
  return (
    <div className="mb-3">
      <label className="flex items-start gap-2 text-sm text-gray-200">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {own
            ? "Let other accounts on a shared device watch videos I save there"
            : "Let other accounts on a shared device watch videos this account saves there"}
        </span>
      </label>
      <p id={hintId} className="mt-1 pl-6 text-xs text-muted">
        {checked
          ? "Applies on every device. Anyone signed in on that device can watch them, even offline."
          : own
            ? "Applies on every device. Your saved videos stay private to you; your password unlocks them offline."
            : "Applies on every device. Its saved videos stay private to it; its password unlocks them offline."}
      </p>
    </div>
  );
}
