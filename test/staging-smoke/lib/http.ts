// STAGING-SMOKE (QA-04b): one HTTP call against staging and its envelope {code, msg, data,
// trace_id} (contracts/openapi.yaml). Every call is recorded on the current step of the report
// (label, HTTP status, business code, time, trace_id, redacted body). Requests never follow
// redirects and time out; a network failure fails the step with the error class name only.
import { Fail, redactBody, type Report } from './report.ts';

export interface CallResult {
  readonly status: number;
  /** Business code of the envelope; null when the body is not an envelope. */
  readonly code: number | null;
  readonly data: unknown;
  readonly traceId: string | null;
  readonly retryAfterSec: number | null;
  readonly etag: string | null;
}

export interface CallOptions {
  readonly label: string;
  readonly headers: Record<string, string>;
  /** The exact body bytes to send (already serialised; signatures hash these bytes). */
  readonly body?: Buffer;
  readonly timeoutMs?: number;
}

let sink: Report | null = null;

export function recordCallsOn(report: Report): void {
  sink = report;
}

export async function call(
  base: string,
  method: string,
  target: string,
  options: CallOptions,
): Promise<CallResult> {
  const started = performance.now();
  const init: RequestInit = {
    method,
    headers: { accept: 'application/json', ...options.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  };
  if (options.body !== undefined) init.body = new Uint8Array(options.body);
  let response: Response;
  try {
    response = await fetch(`${base}${target}`, init);
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    sink?.recordCall({
      label: options.label,
      status: null,
      code: null,
      ms,
      traceId: null,
      raw: null,
    });
    throw new Fail(
      `${options.label}: request failed (${error instanceof Error ? error.name : 'error'})`,
    );
  }
  const text = await response.text().catch(() => '');
  const ms = Math.round(performance.now() - started);
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const envelope =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const code = typeof envelope.code === 'number' ? envelope.code : null;
  const traceId =
    typeof envelope.trace_id === 'string' ? envelope.trace_id : response.headers.get('x-trace-id');
  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  sink?.recordCall({
    label: options.label,
    status: response.status,
    code,
    ms,
    traceId,
    raw: redactBody(parsed, text),
  });
  return {
    status: response.status,
    code,
    data: envelope.data,
    traceId,
    retryAfterSec: Number.isSafeInteger(retryAfter) && retryAfter >= 0 ? retryAfter : null,
    etag: response.headers.get('etag'),
  };
}

/** The data object of a success envelope (HTTP 200, code 0, trace_id); anything else fails. */
export function okData(result: CallResult, label: string): Record<string, unknown> {
  if (result.status !== 200 || result.code !== 0) {
    throw new Fail(
      `${label}: HTTP ${String(result.status)}, code ${String(result.code ?? 'none')}`,
    );
  }
  if (result.traceId === null) throw new Fail(`${label}: envelope without trace_id`);
  const data = result.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Fail(`${label}: data is not an object`);
  }
  return data as Record<string, unknown>;
}

/** `data.reason` of an error envelope, when it is a string. */
export function reasonOf(result: CallResult): string | null {
  const data = result.data;
  if (data === null || typeof data !== 'object') return null;
  const reason = (data as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : null;
}
