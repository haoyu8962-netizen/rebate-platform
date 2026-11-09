import { isInApp } from '@couli/bridge-sdk';

export type Runtime = 'app' | 'wechat' | 'browser';

export interface RuntimeWindow {
  navigator: { userAgent: string };
  __REBATE_BRIDGE__?: unknown;
}

const WECHAT_UA = /MicroMessenger/i;

/**
 * Bridge presence is authoritative; user-agent detection is only for presentation (规划/03 §8.3).
 * Read on every call: native may inject or remove the bridge, so nothing is cached.
 */
export function detectRuntime(win: RuntimeWindow): Runtime {
  // isInApp reads the document-start global __REBATE_BRIDGE__, never the UA.
  if (isInApp()) return 'app';
  return WECHAT_UA.test(win.navigator.userAgent) ? 'wechat' : 'browser';
}

export interface AppApiEnv {
  apiBaseUrl: string | null;
  appId: string | null;
}

/** Build-time variable as a trimmed string; missing, non-string or blank values become null. */
function buildValue(
  name: 'VITE_API_BASE_URL' | 'VITE_APP_ID' | 'VITE_MEDIA_ORIGINS',
): string | null {
  // The only reader of build configuration in the H5 app (Vite inlines these at build time).
  const env: Partial<Record<string, unknown>> = import.meta.env;
  const value = env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** VITE_API_BASE_URL and VITE_APP_ID; missing or blank values become null. */
export function readAppApiEnv(): AppApiEnv {
  return { apiBaseUrl: buildValue('VITE_API_BASE_URL'), appId: buildValue('VITE_APP_ID') };
}

/** A complete http(s) origin exactly as written: no wildcard, path, query, credentials. */
function isOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
}

/** VITE_MEDIA_ORIGINS: comma-separated complete HTTP(S) origins; absent means deny all. */
export function mediaOrigins(): readonly string[] {
  const raw = buildValue('VITE_MEDIA_ORIGINS');
  if (raw === null) return [];
  return Object.freeze(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && isOrigin(part)),
  );
}
