import { createHmac } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]+/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`not base32: ${ch}`);
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * The 6-digit code an authenticator app shows for `secret` (RFC 6238, SHA-1,
 * 30 s). `stepsAhead` moves to a later step: the step used to turn two-step
 * sign-in on is spent, so the next sign-in needs the following one (the server
 * accepts one step ahead).
 */
export function totpCode(
  secret: string,
  stepsAhead = 0,
  nowMs: number = Date.now()
): string {
  const counter = Math.floor(nowMs / 1000 / 30) + stepsAhead;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret))
    .update(message)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}
