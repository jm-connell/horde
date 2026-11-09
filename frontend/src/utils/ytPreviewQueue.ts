/** Serialize feed max-res badge fetches so we don't burst yt-dlp extracts. */

type Task<T> = (signal?: AbortSignal) => Promise<T>;

let chain: Promise<unknown> = Promise.resolve();

/**
 * Run ``task`` after every task queued before it.
 *
 * A task whose ``signal`` has aborted by its turn (its card left the page) is
 * skipped, so leaving a feed does not keep sending YouTube lookups for cards
 * nobody can see.
 */
export function enqueueYtPreview<T>(
  task: Task<T>,
  signal?: AbortSignal
): Promise<T> {
  const start = () => {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    return task(signal);
  };
  const run = chain.then(start, start);
  // Keep the chain alive even if a task fails.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
