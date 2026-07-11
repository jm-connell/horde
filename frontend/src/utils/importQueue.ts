/** Fired when the import/review queue length may have changed. */
export const IMPORT_QUEUE_EVENT = "horde:import-queue";

export function notifyImportQueueChanged(count?: number): void {
  window.dispatchEvent(
    new CustomEvent(IMPORT_QUEUE_EVENT, { detail: { count } })
  );
}
