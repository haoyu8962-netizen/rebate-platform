// Share page API (F1-11a): getSharePage and getShareTpwd, both anonymous (security: []).
// A small fetch wrapper instead of shared/api: the landing first screen stays inside the 03 §12
// budget (no openapi-fetch, no error-code catalog) and never touches the bridge or a token.
import type { Schema } from '@couli/contracts-ts';
import { isAnonymousOperation } from '../../shared/api/anonymous.ts';

export type SharePageData = Schema<'SharePageData'>;
export type SharedProductCard = Schema<'SharedProductCard'>;

/** A {code, msg, data} envelope with a non-zero business code. */
export class ShareApiError extends Error {
  declare readonly code: number;
  declare readonly status: number;
  declare readonly data: unknown;

  constructor(code: number, status: number, data: unknown) {
    super(`share page api error ${code}`);
    this.name = 'ShareApiError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** Network failure, or a response that is not an envelope (gateway page, empty body). */
export class ShareTransportError extends Error {
  constructor(cause: unknown) {
    super('share page request failed', { cause });
    this.name = 'ShareTransportError';
  }
}

export interface ShareApiEnv {
  apiBaseUrl: string;
  appId: string;
  /** SemVer of this H5 build (see app-version.ts); both operations require X-App-Version. */
  appVersion: string;
}

export interface ShareApi {
  getSharePage(linkId: string): Promise<SharePageData>;
  getShareTpwd(linkId: string, ticket: string): Promise<string>;
}

function traceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return uuid;
  const random = () => Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random()}${random()}`.slice(0, 64);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createShareApi(env: ShareApiEnv): ShareApi {
  const base = env.apiBaseUrl.replace(/\/+$/, '');

  async function send(
    method: 'GET' | 'POST',
    template: string,
    linkId: string,
    body?: unknown,
  ): Promise<unknown> {
    // Both operations are public; a template outside the anonymous list is a programming error.
    if (!isAnonymousOperation(method, template)) {
      throw new Error(`share page: ${method} ${template} is not an anonymous operation`);
    }
    const url = base + template.replace('{link_id}', encodeURIComponent(linkId));
    // No Authorization, no X-Channel, no X-Device-Id. X-App-Version is required by both
    // operations; the page sends its own build version (app-version.ts).
    const headers: Record<string, string> = {
      'X-App-Id': env.appId,
      'X-Platform': 'h5',
      'X-App-Version': env.appVersion,
      'X-Trace-Id': traceId(),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    let parsed: unknown;
    try {
      // Resolved per request, so the page always uses the current global fetch.
      response = await globalThis.fetch(url, {
        method,
        headers,
        credentials: 'omit',
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      parsed = await response.json();
    } catch (error) {
      throw new ShareTransportError(error);
    }
    const envelope = asRecord(parsed);
    const code = envelope?.['code'];
    if (envelope === null || typeof code !== 'number' || !Number.isInteger(code)) {
      throw new ShareTransportError(new Error(`no envelope (HTTP ${response.status})`));
    }
    if (code !== 0) throw new ShareApiError(code, response.status, envelope['data']);
    return envelope['data'];
  }

  return {
    async getSharePage(linkId) {
      const data = asRecord(await send('GET', '/v1/share-pages/{link_id}', linkId));
      if (data === null || asRecord(data['product_card']) === null) {
        throw new ShareTransportError(new Error('share page without product_card'));
      }
      return data as unknown as SharePageData;
    },
    async getShareTpwd(linkId, ticket) {
      const data = asRecord(
        await send('POST', '/v1/share-pages/{link_id}/tpwd', linkId, { ticket }),
      );
      const tpwd = data?.['tpwd'];
      if (typeof tpwd !== 'string' || tpwd.length === 0) {
        throw new ShareTransportError(new Error('tpwd response without tpwd'));
      }
      return tpwd;
    },
  };
}
