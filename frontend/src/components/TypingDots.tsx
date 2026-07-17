/** Compact iMessage-style animated dots for chat / summary wait states. */
export default function TypingDots({
  className = "",
  label = "Loading",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-gray-400"
          style={{
            animation: "horde-load-dot 0.95s ease-in-out infinite",
            animationDelay: `${i * 0.12}s`,
          }}
          aria-hidden
        />
      ))}
      <span className="sr-only">{label}</span>
    </span>
  );
}
