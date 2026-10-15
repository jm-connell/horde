import { useEffect, useId, useRef } from "react";

/** Shared chrome for the sign-in, first-run and password forms. */

export const AUTH_INPUT =
  "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none placeholder:text-muted focus:border-accent";
export const AUTH_PRIMARY =
  "w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-50";

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
      <main className="relative z-10 mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
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
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={AUTH_INPUT}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Errors are announced as they appear; the region exists even when empty. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p
      role="alert"
      aria-live="assertive"
      className={message ? "mb-4 text-sm text-red-400" : "sr-only"}
    >
      {message ?? ""}
    </p>
  );
}
