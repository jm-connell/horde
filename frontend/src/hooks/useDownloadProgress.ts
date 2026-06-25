import { useEffect, useState } from "react";
import type { ProgressEvent } from "../types";

export function useDownloadProgress(jobId: number | null) {
  const [event, setEvent] = useState<ProgressEvent | null>(null);

  useEffect(() => {
    if (jobId == null) {
      setEvent(null);
      return;
    }
    const source = new EventSource(`/api/downloads/${jobId}/events`);
    source.onmessage = (e) => {
      try {
        const parsed: ProgressEvent = JSON.parse(e.data);
        setEvent(parsed);
        if (parsed.status === "completed" || parsed.status === "error") {
          source.close();
        }
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [jobId]);

  return event;
}
