import { LoadingMark } from "../../components/LoadingIndicator";
import { useSettings } from "../../hooks/useSettings";
import { isLoadingStyle } from "../../loadingStyles";

/**
 * Holds a YouTube result's place in the mixed search results while YouTube is
 * searched, so the grid does not move when the results arrive. Same frame as a
 * video card, with the app's loading mark.
 */
export default function SearchPlaceholderCard({
  label = "Searching YouTube…",
}: {
  label?: string;
}) {
  const [settings] = useSettings();
  const style = isLoadingStyle(settings.loadingStyle)
    ? settings.loadingStyle
    : "dots";
  return (
    <div
      data-horde="search-placeholder"
      // The results region is marked busy; one card per place would repeat it.
      aria-hidden
      className="flex h-full flex-col overflow-hidden max-sm:border-b max-sm:border-ink-700 sm:rounded-xl sm:bg-ink-900 sm:ring-1 sm:ring-ink-700"
    >
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-gradient-to-br from-accent/15 via-ink-800 to-ink-900">
        <span
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent motion-reduce:hidden"
          style={{ animation: "horde-search-sheen 1.8s ease-in-out infinite" }}
          aria-hidden
        />
        <LoadingMark style={style} compact />
      </div>
      <div className="space-y-2 p-3">
        <p className="text-sm font-medium text-gray-300">{label}</p>
        <div className="h-2 w-2/3 rounded-full bg-ink-700/70" aria-hidden />
      </div>
    </div>
  );
}
