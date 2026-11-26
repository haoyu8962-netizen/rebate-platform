import { createEnvelope, type EventEnvelope } from '@sentry/core';
import { expect, it } from 'vitest';
import { createRootLogger } from '../logging/logger.ts';
import {
  envelopeSender,
  envelopeTarget,
  makeFetchTransport,
  type EnvelopeTarget,
  type TransportFetch,
} from './transport.ts';

const KEY = 'unitTestPublicKeyPlaceholder';
const DSN = `https://${KEY}@glitchtip.unit.test:8443/prefix/7`;

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function memoryLogger(): { logger: ReturnType<typeof createRootLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

function recordingFetch(answer: (call: Call) => Promise<Response> | Response): {
  fetch: TransportFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: TransportFetch = (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

function targetOf(dsn: string): EnvelopeTarget {
  const target = envelopeTarget(dsn);
  if (target === undefined) throw new Error('not a DSN');
  return target;
}

it('[AC-QA-13d#5] the envelope endpoint keeps scheme, host, port and prefix, without query string', () => {
  expect(envelopeTarget(DSN)).toEqual({
    endpoint: 'https://glitchtip.unit.test:8443/prefix/api/7/envelope/',
    publicKey: KEY,
  });
  expect(envelopeTarget(`http://${KEY}@10.1.2.3/12`)?.endpoint).toBe(
    'http://10.1.2.3/api/12/envelope/',
  );
  expect(envelopeTarget('https://glitchtip.unit.test/7')).toBeUndefined();
  expect(envelopeTarget(`https://${KEY}@glitchtip.unit.test/abc`)).toBeUndefined();
  expect(envelopeTarget(`ftp://${KEY}@glitchtip.unit.test/7`)).toBeUndefined();
  expect(envelopeTarget('not a url')).toBeUndefined();
});

it('[AC-QA-13d#5] one POST with the body, X-Sentry-Auth carrying the key, no redirect following, a signal', async () => {
  const { logger, lines } = memoryLogger();
  const { fetch, calls } = recordingFetch(() => new Response('{}', { status: 200 }));
  const send = envelopeSender({ target: targetOf(DSN), fetch, logger }, { 'user-agent': 'ua' });
  const response = await send({ body: 'envelope-body' });
  expect(response.statusCode).toBe(200);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call?.url).toBe('https://glitchtip.unit.test:8443/prefix/api/7/envelope/');
  expect(call?.init?.method).toBe('POST');
  expect(call?.init?.body).toBe('envelope-body');
  expect(call?.init?.redirect).toBe('manual');
  expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  const headers = new Headers(call?.init?.headers);
  expect(headers.get('x-sentry-auth')).toMatch(new RegExp(`sentry_key=${KEY}(,|$)`));
  expect(headers.get('x-sentry-auth')).toContain('sentry_version=7');
  expect(headers.get('content-type')).toBe('application/x-sentry-envelope');
  expect(headers.get('user-agent')).toBe('ua');
  expect(lines).toEqual([]);
});

const REDIRECT_HEADERS = { location: 'https://x.test/' };

it.each([
  ['an error status', () => new Response('{}', { status: 500 }), 500],
  ['a redirect', () => new Response(null, { status: 308, headers: REDIRECT_HEADERS }), 308],
] as const)(
  '[AC-QA-13d#4] %s is not retried and logs one warn without the DSN',
  async (_name, answer, status) => {
    const { logger, lines } = memoryLogger();
    const { fetch, calls } = recordingFetch(answer);
    const response = await envelopeSender({ target: targetOf(DSN), fetch, logger })({ body: 'b' });
    expect(response.statusCode).toBe(status);
    expect(calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 40, status });
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain('glitchtip.unit.test');
  },
);

it('[AC-QA-13d#4] a rejecting, a throwing and a hanging fetch resolve without rejecting', async () => {
  const { logger, lines } = memoryLogger();
  const target = targetOf(DSN);
  const rejecting: TransportFetch = () => Promise.reject(new TypeError(`fetch failed ${DSN}`));
  const throwing: TransportFetch = () => {
    throw new TypeError('sync throw');
  };
  const hanging: TransportFetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });
  const rejected = envelopeSender({ target, fetch: rejecting, logger })({ body: 'b' });
  await expect(rejected).resolves.toEqual({});
  const thrown = envelopeSender({ target, fetch: throwing, logger })({ body: 'b' });
  await expect(thrown).resolves.toEqual({});
  const began = performance.now();
  await expect(
    envelopeSender({ target, fetch: hanging, logger, timeoutMs: 50 })({ body: 'b' }),
  ).resolves.toEqual({});
  expect(performance.now() - began).toBeLessThan(2_000);
  expect(lines).toHaveLength(3);
  expect(lines.join('\n')).not.toContain(KEY);
  expect(lines.join('\n')).not.toContain('glitchtip.unit.test');
});

it('[AC-QA-13d#5] makeFetchTransport sends serialized envelopes through createTransport', async () => {
  const { logger } = memoryLogger();
  const { fetch, calls } = recordingFetch(() => new Response('{}', { status: 200 }));
  const transport = makeFetchTransport({ target: targetOf(DSN), fetch, logger })({
    url: 'ignored',
    recordDroppedEvent: () => undefined,
    headers: { 'user-agent': 'sentry.javascript.core', authorization: 'never' },
  });
  const item: EventEnvelope[1][number] = [{ type: 'event' }, { message: 'unit-event' }];
  const envelope = createEnvelope<EventEnvelope>({}, [item]);
  await transport.send(envelope);
  expect(await transport.flush(1_000)).toBe(true);
  expect(calls).toHaveLength(1);
  expect(String(calls[0]?.init?.body)).toContain('unit-event');
  expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBeNull();
});
