/**
 * What the AI panel needs to know about the video it is for, so a downloaded
 * video and a streamed one use the same components. Built by
 * `useWatchAi`; keep `summarize` stable per `key`.
 */
export interface AiTarget {
  /** Identity of the video; the panel resets when it changes. */
  key: string;
  summary: string | null;
  /** The server is generating the summary (library videos only). */
  processingSummary: boolean;
  /**
   * Nothing generates this video's summary on its own (a stream): the section
   * starts collapsed while there is none, and opening it generates one.
   */
  generateOnExpand?: boolean;
  /** Small muted line under the summary (e.g. when saved results expire). */
  note?: string | null;
  /** Generate (or regenerate) the summary and publish the result to the page. */
  summarize: (force: boolean, signal: AbortSignal) => Promise<void>;
}
