// Alertmanager webhook → WeCom group robot forwarder (B1-25c; 规划/02 §13; BR-WDR-24; D10-2605 /
// D10-2612 / D10-2622). Node built-in modules only. Listens on 127.0.0.1; the couli Alertmanager
// posts to /finance and /oncall (alertmanager.yml) and each receiver is sent to its own robot.
// - The robot address (with its key) is read from a node file per request (path given at start);
//   it never appears in a log line, a robot message, a response body or an exit message.
// - Each push has its own 5-second timeout; a failed push (network, timeout, HTTP error, or HTTP 200
//   with errcode ≠ 0) is retried at most 3 times with backoff; the webhook then answers 502 so that
//   Alertmanager retries the notification itself.
// - The markdown carries only alertname, severity, firing / resolved, times (+08:00) and summary;
//   summary text loses URLs, the robot key, phone / id / card numbers, e-mail style accounts and
//   sensitive key=value pairs, with the same free-text patterns as platform/logging/redaction.
// Usage: node webhook.ts --listen=127.0.0.1:<port> --finance-file=<path> --oncall-file=<path>
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

export type Receiver = 'finance' | 'oncall';

export interface ForwarderOptions {
  webhookFiles: Readonly<Record<Receiver, string>>;
  readWebhookFile: (path: string) => Promise<string>;
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutSignal: (milliseconds: number) => AbortSignal;
}

const RECEIVERS: readonly Receiver[] = ['finance', 'oncall'];
export const PUSH_TIMEOUT_MS = 5000;
export const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000] as const;
const MAX_BODY_BYTES = 1024 * 1024;
// WeCom markdown content is limited to 4096 bytes (UTF-8); keep a margin for the tail line.
const MAX_CONTENT_BYTES = 3900;
const REDACTED = '[已去除]';

// Same free-text net as apps/api/src/modules/platform/logging/redaction.ts (redactText).
const email =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const digit = '[0-9０-９]';
const id18 = `${digit}(?:[ -]?${digit}){16}(?:[ -]?${digit}|[Xx])`;
const bankCard = `${digit}(?:[ -]?${digit}){15,18}`;
const id15 = `${digit}(?:[ -]?${digit}){14}`;
const phone = `(?:(?:\\+[8８][6６]|[0０][0０][8８][6６]|[8８][6６])[ -]?)?[1１](?:[ -]?${digit}){10}`;
const personalNumber = new RegExp(
  `(?<!${digit})(?:${id18}|${bankCard}|${id15}|${phone})(?!${digit})`,
  'g',
);
// Key names follow SENSITIVE_KEYS of the same module, plus the robot's own `key`.
const SENSITIVE_NAMES = [
  'phone',
  'phones',
  'mobile',
  'mobile_phone',
  'phone_number',
  'contact_phone',
  'id_no',
  'id_card',
  'id_card_no',
  'id_number',
  'birth_date',
  'real_name',
  'payee_name',
  'alipay_logon_id',
  'alipay_account',
  'bank_card_no',
  'card_no',
  'payee_account',
  'authorization',
  'cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'step_up_token',
  'secret',
  'install_secret',
  'captcha_token',
  'sms_code',
  'key',
  'api_key',
];
const sensitivePair = new RegExp(
  `(?<![A-Za-z0-9_-])(${SENSITIVE_NAMES.join('|')})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`,
  'gi',
);
const url = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;

/** Literal secrets of one robot address: the address itself and each of its query values. */
function secretsOf(robot: URL): string[] {
  const values = [robot.href, ...robot.searchParams.values()];
  for (const value of [...values]) values.push(encodeURIComponent(value));
  return [...new Set(values.filter((value) => value.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
}

function clean(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result
    .replace(url, REDACTED)
    .replace(sensitivePair, (_match, name: string, separator: string) => {
      return `${name}${separator}${REDACTED}`;
    })
    .replace(email, REDACTED)
    .replace(personalNumber, REDACTED)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

interface Alert {
  status: string;
  alertname: string;
  severity: string;
  startsAt: string | null;
  endsAt: string | null;
  summary: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function alertsOf(body: unknown): Alert[] | null {
  const alerts = field(body, 'alerts');
  if (!Array.isArray(alerts)) return null;
  return alerts.map((alert: unknown) => {
    const labels = field(alert, 'labels');
    const status = text(field(alert, 'status'));
    const endsAt = text(field(alert, 'endsAt'));
    return {
      status: status === 'resolved' ? 'resolved' : 'firing',
      alertname: text(field(labels, 'alertname')),
      severity: text(field(labels, 'severity')),
      startsAt: text(field(alert, 'startsAt')) || null,
      endsAt: status === 'resolved' && endsAt !== '' ? endsAt : null,
      summary: text(field(field(alert, 'annotations'), 'summary')),
    };
  });
}

/** Render an RFC 3339 instant as +08:00 wall time; anything unparsable is left out. */
function beijing(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= 0) return null;
  const local = new Date(time + 8 * 3600_000).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 19)} (+08:00)`;
}

function block(alert: Alert, secrets: readonly string[]): string {
  const color = alert.status === 'resolved' ? 'info' : 'warning';
  const name = clean(alert.alertname, secrets) || '(未命名告警)';
  const severity = clean(alert.severity, secrets) || '-';
  const lines = [`<font color="${color}">${alert.status}</font> **${name}** 级别：${severity}`];
  const started = beijing(alert.startsAt);
  if (started !== null) lines.push(`> 开始：${started}`);
  const ended = beijing(alert.endsAt);
  if (ended !== null) lines.push(`> 恢复：${ended}`);
  const summary = clean(alert.summary, secrets);
  if (summary !== '') lines.push(`> ${summary}`);
  return lines.join('\n');
}

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

export function markdownOf(
  receiver: Receiver,
  alerts: readonly Alert[],
  secrets: readonly string[],
): string {
  const firing = alerts.filter((alert) => alert.status === 'firing').length;
  const head = `**couli 告警（${receiver}）** 触发 ${firing} 条，恢复 ${alerts.length - firing} 条`;
  let content = head;
  let shown = 0;
  for (const alert of alerts) {
    const next = `${content}\n\n${block(alert, secrets)}`;
    if (bytes(next) > MAX_CONTENT_BYTES) break;
    content = next;
    shown++;
  }
  if (shown < alerts.length)
    content += `\n\n另有 ${alerts.length - shown} 条未列出，见 Alertmanager。`;
  return content;
}

type Attempt = { ok: true } | { ok: false; reason: string };

async function pushOnce(robot: URL, body: string, options: ForwarderOptions): Promise<Attempt> {
  const signal = options.timeoutSignal(PUSH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await options.fetch(robot.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
      redirect: 'error',
      signal,
    });
  } catch (error) {
    // The error text may carry the address; only its kind is kept.
    const name = error instanceof Error ? error.name : '';
    return {
      ok: false,
      reason:
        signal.aborted || name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
  try {
    if (!response.ok) return { ok: false, reason: `http_${String(response.status)}` };
    const result: unknown = await response.json();
    const code = field(result, 'errcode');
    if (code === 0) return { ok: true };
    return {
      ok: false,
      reason: Number.isSafeInteger(code) ? `errcode_${String(code)}` : 'invalid_response',
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { ok: false, reason: name === 'TimeoutError' ? 'timeout' : 'invalid_response' };
  }
}

function reply(status: number, value: Record<string, unknown>): Response {
  return Response.json(value, { status });
}

export async function handleAlertmanagerWebhook(
  request: Request,
  options: ForwarderOptions,
): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');
  const receiver = RECEIVERS.find((name) => name === path);
  if (receiver === undefined) return reply(404, { ok: false, reason: 'unknown_receiver' });
  if (request.method !== 'POST') return reply(405, { ok: false, reason: 'method_not_allowed' });

  let alerts: Alert[] | null;
  try {
    const raw = await request.text();
    if (bytes(raw) > MAX_BODY_BYTES) return reply(413, { ok: false, reason: 'too_large' });
    alerts = alertsOf(JSON.parse(raw));
  } catch {
    alerts = null;
  }
  if (alerts === null) return reply(400, { ok: false, reason: 'not_an_alertmanager_webhook' });
  if (alerts.length === 0) return reply(200, { ok: true, receiver, attempts: 0 });

  let robot: URL;
  try {
    robot = new URL((await options.readWebhookFile(options.webhookFiles[receiver])).trim());
  } catch {
    return reply(500, { ok: false, receiver, reason: 'webhook_file_unreadable' });
  }
  if (robot.protocol !== 'https:' || robot.username !== '' || robot.password !== '') {
    return reply(500, { ok: false, receiver, reason: 'webhook_file_invalid' });
  }

  const content = markdownOf(receiver, alerts, secretsOf(robot));
  const body = JSON.stringify({ msgtype: 'markdown', markdown: { content } });
  let last: Attempt = { ok: false, reason: 'not_sent' };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await options.sleep(BACKOFF_MS[attempt - 1] ?? 4000);
    last = await pushOnce(robot, body, options);
    if (last.ok) return reply(200, { ok: true, receiver, attempts: attempt + 1 });
  }
  return reply(502, {
    ok: false,
    receiver,
    attempts: MAX_RETRIES + 1,
    reason: last.ok ? 'not_sent' : last.reason,
  });
}

// ---- process entry ----

function flag(argv: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const values = argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length));
  if (values.length !== 1 || values[0] === '') throw new Error(`exactly one --${name}=<value>`);
  return values[0]!;
}

function line(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
}

async function toRequest(req: IncomingMessage): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = chunk as Buffer;
    size += piece.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(piece);
  }
  const init: RequestInit = { method: req.method ?? 'GET' };
  if (init.method !== 'GET' && init.method !== 'HEAD')
    init.body = Buffer.concat(chunks).toString('utf8');
  return new Request(`http://127.0.0.1${(req.url ?? '/').split('?')[0] ?? '/'}`, init);
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  options: ForwarderOptions,
): Promise<void> {
  let response: Response;
  try {
    const request = await toRequest(req);
    response =
      request === null
        ? reply(413, { ok: false, reason: 'too_large' })
        : await handleAlertmanagerWebhook(request, options);
  } catch {
    response = reply(500, { ok: false, reason: 'internal' });
  }
  const body = await response.text();
  // The body holds only receiver, attempts and a fixed reason code: safe to log.
  line({ status: response.status, result: body });
  res.writeHead(response.status, { 'content-type': 'application/json' }).end(body);
}

function main(): void {
  const argv = process.argv.slice(2);
  const listen = flag(argv, 'listen');
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(listen);
  if (match === null) throw new Error('--listen must be 127.0.0.1:<port>');
  const options: ForwarderOptions = {
    webhookFiles: { finance: flag(argv, 'finance-file'), oncall: flag(argv, 'oncall-file') },
    readWebhookFile: (path) => readFile(path, 'utf8'),
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
  };
  const server = createServer((req, res) => {
    void serve(req, res, options);
  });
  server.listen(Number(match[1]), '127.0.0.1', () => {
    line({ event: 'listening', listen });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    main();
  } catch (error) {
    // Start-up errors name only flags; no file content is read before the first request.
    process.stderr.write(`forwarder: ${error instanceof Error ? error.message : 'start failed'}\n`);
    process.exitCode = 1;
  }
}
