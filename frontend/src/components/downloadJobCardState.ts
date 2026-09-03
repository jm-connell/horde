/** Recent-download card: the library video was deleted or replaced. */
export function isLibraryVideoGone(
  isDeviceJob: boolean,
  videoMissing?: boolean,
  superseded?: boolean
): boolean {
  return !isDeviceJob && Boolean(videoMissing || superseded);
}

export function canEditDownloadJobNotes(
  isDeviceJob: boolean,
  failed: boolean,
  cancelled: boolean,
  videoGone: boolean
): boolean {
  return !isDeviceJob && !failed && !cancelled && !videoGone;
}

/** Queue a new library copy from a history card whose video was deleted. */
export function canRedownloadRemovedJob(
  completed: boolean,
  isDeviceJob: boolean,
  failed: boolean,
  videoMissing?: boolean,
  superseded?: boolean
): boolean {
  return (
    completed &&
    !isDeviceJob &&
    !failed &&
    Boolean(videoMissing) &&
    !superseded
  );
}
