import type { ProgressEvent } from "../types";

// Open an SSE stream for a single download job. Returns a cleanup function that
// closes the connection. The stream auto-closes on a terminal event.
export function subscribeToJob(
  jobId: number,
  onEvent: (event: ProgressEvent) => void
): () => void {
  const source = new EventSource(`/api/downloads/${jobId}/events`);
  source.onmessage = (e) => {
    try {
      const parsed: ProgressEvent = JSON.parse(e.data);
      onEvent(parsed);
      if (parsed.status === "completed" || parsed.status === "error") {
        source.close();
      }
    } catch {
      // ignore malformed frames
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}
