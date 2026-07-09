import { useSettings, type LoadingStyle } from "../hooks/useSettings";

export default function LoadingIndicator({
  label = "Loading",
  className = "py-20",
}: {
  label?: string;
  className?: string;
}) {
  const [settings] = useSettings();
  const style: LoadingStyle = settings.loadingStyle ?? "dots";

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 text-gray-500 ${className}`}
      role="status"
      aria-live="polite"
    >
      {style === "dots" && (
        <div className="flex items-center gap-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_10px_rgb(var(--accent)/0.45)]"
              style={{
                animation: "horde-load-dot 0.95s ease-in-out infinite",
                animationDelay: `${i * 0.12}s`,
              }}
            />
          ))}
        </div>
      )}
      {style === "spinner" && (
        <span
          className="h-8 w-8 rounded-full border-2 border-ink-600 border-t-accent shadow-[0_0_12px_rgb(var(--accent)/0.25)]"
          style={{ animation: "horde-load-spin 0.65s linear infinite" }}
          aria-hidden
        />
      )}
      {style === "bar" && (
        <span
          className="relative h-1.5 w-32 overflow-hidden rounded-full bg-ink-700"
          aria-hidden
        >
          <span
            className="absolute inset-y-0 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent)/0.5)]"
            style={{ animation: "horde-load-bar 1s ease-in-out infinite" }}
          />
        </span>
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}
