import { useId } from "react";

/**
 * "Share this account’s downloads with other accounts on a device": on keeps videos saved for
 * offline viewing open to everyone who uses the device; off keeps them private
 * to the account (its password unlocks them with no connection).
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
            ? "Share my downloads with other accounts on this device"
            : "Share this account’s downloads with other accounts on a device"}
        </span>
      </label>
      <p id={hintId} className="mt-1 pl-6 text-xs text-muted">
        {checked
          ? "Anyone using the same device can watch the videos saved there, even without a connection."
          : own
            ? "Videos you save on a shared device stay private to you. Your password unlocks them with no connection."
            : "Videos saved on a shared device stay private to this account. Its password unlocks them with no connection."}
      </p>
    </div>
  );
}
