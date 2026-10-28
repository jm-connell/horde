/**
 * A rough guide, not a rule: Horde accepts any non-empty password and only
 * tells people how guessable theirs looks. Estimates entropy from length and
 * character variety, with penalties for repeats and well-known passwords.
 */

export type StrengthLevel = 0 | 1 | 2 | 3;

export const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Strong"] as const;

const COMMON = new Set([
  "password",
  "123456",
  "12345678",
  "123456789",
  "qwerty",
  "letmein",
  "admin",
  "welcome",
  "iloveyou",
  "abc123",
  "111111",
  "000000",
  "monkey",
  "dragon",
  "horde",
]);

export function passwordStrength(password: string): StrengthLevel {
  if (!password) return 0;
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[0-9!]+$/, ""))) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  // Repeated characters add little: count each distinct character once, plus
  // a small share for the rest.
  const distinct = new Set(password).size;
  const effective = distinct + (password.length - distinct) * 0.25;
  const bits = effective * Math.log2(pool);
  if (bits < 35) return 0;
  if (bits < 50) return 1;
  if (bits < 70) return 2;
  return 3;
}
