// Pure helpers of the share page (F1-11a): address parsing, +08:00 quote time, URL checks.

/** Server-issued link ids: one opaque path segment (contract LinkId); anything else is no link. */
const LINK_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The share address is `/<link_id>` (contracts/bridge.schema.json share_page_paths keeps the exact
 * pattern open). Any other shape, including `/`, means the address carries no link id.
 */
export function linkIdFromPath(pathname: string): string | null {
  const segments = pathname.split('/').filter((part) => part.length > 0);
  if (segments.length !== 1) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(segments[0]!);
  } catch {
    return null;
  }
  return LINK_ID.test(segment) ? segment : null;
}

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * BR-PRICE-11 quote time in +08:00: `HH:mm`, or `MM-DD HH:mm` when it is not the same +08:00
 * calendar day as `nowMs`. Unparsable input gives null (nothing is shown).
 */
export function formatQuoteTime(iso: string, nowMs: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const quoted = new Date(at + UTC8_OFFSET_MS);
  const now = new Date(nowMs + UTC8_OFFSET_MS);
  const time = `${pad(quoted.getUTCHours())}:${pad(quoted.getUTCMinutes())}`;
  const sameDay =
    quoted.getUTCFullYear() === now.getUTCFullYear() &&
    quoted.getUTCMonth() === now.getUTCMonth() &&
    quoted.getUTCDate() === now.getUTCDate();
  return sameDay ? time : `${pad(quoted.getUTCMonth() + 1)}-${pad(quoted.getUTCDate())} ${time}`;
}

/** Server-given navigation targets are only followed as absolute http(s) URLs. */
export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * VITE_MEDIA_ORIGINS check (same rule as shared/env.ts mediaOrigins, which the landing cannot
 * import because env.ts pulls in the bridge SDK): only complete http(s) origins, absent = deny.
 */
export function parseMediaOrigins(raw: string | null): readonly string[] {
  if (raw === null) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      if (part.length === 0) return false;
      try {
        const url = new URL(part);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === part;
      } catch {
        return false;
      }
    });
}

/** An image is shown only when its origin is on the media allowlist. */
export function isAllowedMedia(src: string | null, origins: readonly string[]): src is string {
  if (src === null || !isWebUrl(src)) return false;
  return origins.includes(new URL(src).origin);
}

const WECHAT_UA = /MicroMessenger/i;

/** Presentation-only check (规划/03 §8.3): the WeChat in-app browser. */
export function isWeChat(userAgent: string): boolean {
  return WECHAT_UA.test(userAgent);
}
