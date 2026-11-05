import TuningPanel from "../../components/discover/TuningPanel";

/**
 * Your Recommended algorithm: the same settings as the Algorithm panel next
 * to the feed (both read and save one copy, so they always match).
 */
export default function AlgorithmSection() {
  return (
    <section
      aria-labelledby="algorithm-heading"
      data-setting="recommended-algorithm"
      className="space-y-3"
    >
      <div>
        <h2
          id="algorithm-heading"
          className="text-xs font-semibold uppercase tracking-wider text-gray-400"
        >
          Recommendation algorithm
        </h2>
        <p className="mt-1 text-sm text-muted">
          How your Recommended feed is picked. Only your feed changes; open
          Algorithm on the feed to watch it re-rank as you go.
        </p>
      </div>
      <TuningPanel variant="page" />
    </section>
  );
}
