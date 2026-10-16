function FullscreenGlyph({ exit }: { exit: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
    >
      {exit ? (
        <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
      ) : (
        <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
      )}
    </svg>
  );
}

export default function FullscreenButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const label = active ? "Exit fullscreen" : "Fullscreen";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ui-nav-icon ui-player-chrome flex h-7 w-7 items-center justify-center bg-transparent p-0 ${
        active ? "text-accent" : "text-gray-200 hover:text-accent"
      }`}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <FullscreenGlyph exit={active} />
    </button>
  );
}
