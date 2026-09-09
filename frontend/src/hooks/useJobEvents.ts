import type { ProgressEvent } from "../types";

function parseFrame(data: string): ProgressEvent | null {
  try {
    return JSON.parse(data) as ProgressEvent;
  } catch {
    return null;
  }
}

// Open an SSE stream for a single download job. Returns a cleanup function that
// closes the connection. The stream auto-closes on a terminal event.
export function subscribeToJob(
  jobId: number,
  onEvent: (event: ProgressEvent) => void
): () => void {
  const source = new EventSource(`/api/downloads/${jobId}/events`);
  source.onmessage = (e) => {
    const parsed = parseFrame(e.data);
    if (!parsed) return;
    onEvent(parsed);
    if (
      parsed.status === "completed" ||
      parsed.status === "error" ||
      parsed.status === "cancelled"
    ) {
      source.close();
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}

/** One EventSource for the whole download queue (avoids the HTTP/1.1 socket cap). */
export function subscribeToQueue(
  onEvent: (event: ProgressEvent) => void
): () => void {
  const source = new EventSource("/api/downloads/events");
  source.onmessage = (e) => {
    const parsed = parseFrame(e.data);
    if (parsed) onEvent(parsed);
  };
  return () => source.close();
}
