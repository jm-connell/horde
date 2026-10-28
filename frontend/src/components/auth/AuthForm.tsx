import { useEffect, useId, useRef } from "react";
import { passwordStrength, STRENGTH_LABELS } from "./passwordStrength";

/** Shared chrome for the sign-in, first-run and password forms. */

export const AUTH_INPUT =
  "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden placeholder:text-muted focus:border-accent";
export const AUTH_PRIMARY =
  "w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-soft disabled:opacity-50";

export function AuthCard({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-full overflow-x-hidden">
      <main className="relative z-10 mx-auto flex min-h-svh max-w-md flex-col justify-center px-4 py-12">
        <div className="ui-panel rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700">
          {eyebrow && <p className="mb-1 text-xs text-muted">{eyebrow}</p>}
          <h1 className="mb-5 text-2xl font-semibold text-gray-100">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  focusOnMount,
  hint,
  required = true,
  inputMode,
  strength = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password";
  autoComplete?: string;
  /** Move focus here when the form appears (first field of a screen). */
  focusOnMount?: boolean;
  hint?: string;
  required?: boolean;
  /** `numeric` brings up the number pad for one-time codes. */
  inputMode?: "numeric" | "text";
  /** Show a strength meter under a new password (advice only, never enforced). */
  strength?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-sm text-gray-300">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={AUTH_INPUT}
      />
      {strength && value && <StrengthMeter password={value} />}
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

const METER_FILL = ["bg-danger", "bg-warning", "bg-accent", "bg-accent"];

function StrengthMeter({ password }: { password: string }) {
  const level = passwordStrength(password);
  return (
    <div
      className="mt-2 flex items-center gap-2"
      data-testid="password-strength"
    >
      <div className="flex flex-1 gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full ${i <= level ? METER_FILL[level] : "bg-ink-700"}`}
          />
        ))}
      </div>
      <span className="w-16 text-right text-xs text-muted" aria-live="polite">
        {STRENGTH_LABELS[level]}
      </span>
    </div>
  );
}

/** Errors are announced as they appear; the region exists even when empty. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p
      role="alert"
      aria-live="assertive"
      className={message ? "mb-4 text-sm text-danger" : "sr-only"}
    >
      {message ?? ""}
    </p>
  );
}
