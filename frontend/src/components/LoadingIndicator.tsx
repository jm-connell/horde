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
        <div className="flex items-center gap-1.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2 w-2 rounded-full bg-accent"
              style={{
                animation: "horde-load-dot 1.05s ease-in-out infinite",
                animationDelay: `${i * 0.15}s`,
              }}
            />
          ))}
        </div>
      )}
      {style === "spinner" && (
        <span
          className="h-7 w-7 rounded-full border-2 border-ink-600 border-t-accent"
          style={{ animation: "horde-load-spin 0.7s linear infinite" }}
          aria-hidden
        />
      )}
      {style === "bar" && (
        <span
          className="relative h-1 w-28 overflow-hidden rounded-full bg-ink-700"
          aria-hidden
        >
          <span
            className="absolute inset-y-0 w-1/3 rounded-full bg-accent"
            style={{ animation: "horde-load-bar 1.1s ease-in-out infinite" }}
          />
        </span>
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}
