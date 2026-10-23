/** Small pure helpers for the two-step sign-in screens. */

/** A recovery code is ten letters and digits, written in two groups of five. */
const RECOVERY_SHAPE = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/;

/** True when `raw` looks like a recovery code rather than a 6-digit code. */
export function looksLikeRecoveryCode(raw: string): boolean {
  return RECOVERY_SHAPE.test(raw.trim());
}

/** The text file offered for download next to the recovery codes. */
export function recoveryCodesText(
  username: string,
  codes: string[],
  now: Date = new Date()
): string {
  return [
    `Horde recovery codes for ${username}`,
    `Made ${now.toISOString().slice(0, 10)}`,
    "",
    "Each code works once, in place of the 6-digit code from your",
    "authenticator app. Making new codes cancels these.",
    "Keep this file somewhere safe and private.",
    "",
    ...codes,
    "",
  ].join("\n");
}

/** The file name for the download. */
export function recoveryCodesFileName(username: string): string {
  const safe = username.replace(/[^\w.-]+/g, "_").slice(0, 40) || "account";
  return `horde-recovery-codes-${safe}.txt`;
}
