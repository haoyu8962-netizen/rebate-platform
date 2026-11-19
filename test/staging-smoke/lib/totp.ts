// STAGING-SMOKE: client-side RFC 6238 codes for the staging smoke admin account (the same
// parameters as apps/api/src/modules/admin/domain/totp.ts: HMAC-SHA-1, T0 = 0, 30 s, 6 digits).
// Self-contained on purpose: the smoke scripts run on the test node from a plain checkout and do
// not import application code. A code is never printed or written anywhere.
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_MS = 30_000;

export function decodeBase32(text: string): Buffer {
  const body = text.replace(/=+$/, '');
  if (body.length === 0) throw new Error('totp secret is empty');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of body) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('totp secret is not upper-case Base32');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Uint8Array, counter: bigint): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function stepOf(atMs: number): bigint {
  return BigInt(Math.floor(atMs / TOTP_STEP_MS));
}

/**
 * Hands out codes for strictly increasing time steps: the server accepts a step once per account
 * (admin_users.totp_last_step), so every call after the first waits for a fresh step. A code is
 * only handed out with at least `marginMs` left in its step, so it is not stale on arrival.
 */
export function createCodeSource(secretBase32: string, marginMs = 5_000) {
  const key = decodeBase32(secretBase32);
  let lastStep = -1n;
  return {
    async next(): Promise<string> {
      for (;;) {
        const now = Date.now();
        const step = stepOf(now);
        const left = TOTP_STEP_MS - (now % TOTP_STEP_MS);
        if (step > lastStep && left >= marginMs) {
          lastStep = step;
          return hotp(key, step);
        }
        await sleep(left + 200);
      }
    },
  };
}
