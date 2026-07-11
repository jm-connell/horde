/** Serialize feed max-res badge fetches so we don't burst yt-dlp extracts. */

type Task<T> = () => Promise<T>;

let chain: Promise<unknown> = Promise.resolve();

export function enqueueYtPreview<T>(task: Task<T>): Promise<T> {
  const run = chain.then(task, task);
  // Keep the chain alive even if a task fails.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
