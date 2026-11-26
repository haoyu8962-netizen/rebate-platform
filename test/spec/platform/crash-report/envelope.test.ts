// [AC-QA-13d#5] Reports go to GlitchTip's envelope endpoint, derived from the DSN (task: fetch 传输
// 包 createTransport，发 envelope 接口): every request is a POST to
// `<scheme>://<host>[:<port>]/api/<project id>/envelope/`, authenticated with the DSN's public key
// (`sentry_key` in the query string or in the X-Sentry-Auth header), and it carries the event. The
// fake fetch answers 200 only there: a wrong project id, the old `/api/<project id>/store/` endpoint
// or another method gets 404, a request without the key (or with another one) 401, so "sent
// successfully" means sent to the right place, authenticated. The expected endpoints are written
// out by hand.
import { expect, it } from 'vitest';
import { startCrashReporting } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  FakeProcess,
  PUBLIC_KEY,
  configOf,
  dsnFor,
  endpointOf,
  fakeFetch,
  memoryLogger,
  sentEvents,
  type Entry,
} from './kit.ts';

const CASES: readonly (readonly [Entry, string, string, string])[] = [
  ['api', dsnFor('glitchtip.example.test'), 'https://glitchtip.example.test', '3'],
  [
    'worker',
    dsnFor('glitchtip.internal:8443', 'https', '7'),
    'https://glitchtip.internal:8443',
    '7',
  ],
  ['payout', dsnFor('172.20.0.5:8000', 'http'), 'http://172.20.0.5:8000', '3'],
  ['payout', dsnFor('10.1.2.3', 'http', '12'), 'http://10.1.2.3', '12'],
];

it.each(CASES)(
  '[AC-QA-13d#5] %s with DSN %s: POST to %s/api/%s/envelope/, answered 200',
  async (entry: Entry, dsn: string, origin: string, project: string) => {
    const endpoint = `${origin}/api/${project}/envelope/`;
    const { logger } = memoryLogger(entry);
    const transport = fakeFetch('ok', undefined, { dsn });
    const reporter = await startCrashReporting({
      entry,
      config: configOf({ [DSN_VAR]: dsn }),
      logger,
      fetch: transport.fetch,
      process: new FakeProcess(),
    });
    try {
      expect(reporter.enabled).toBe(true);
      reporter.captureException(new Error(`qa13d-envelope ${entry} ${project}`));
      await reporter.flush(2_000);
    } finally {
      await reporter.close(1_000);
    }
    const sent = transport.requests.map((request) => ({
      method: request.method,
      endpoint: endpointOf(request.url),
      status: request.status,
    }));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).toEqual(sent.map(() => ({ method: 'POST', endpoint, status: 200 })));
    const events = await sentEvents(transport.requests);
    const values = events.flatMap((event) => event.exception?.values ?? []);
    expect(values.map((value) => value.value)).toEqual([`qa13d-envelope ${entry} ${project}`]);
    // The fake's own rule, so a 200 above can only come from that endpoint.
    const wrong = [
      `${origin}/api/${project}9/envelope/`,
      `${origin}/api/${project}/store/`,
      `${origin}/${project}/envelope/`,
    ];
    const statuses: number[] = [];
    for (const url of wrong) {
      statuses.push((await transport.fetch(url, { method: 'POST', body: '{}' })).status);
    }
    statuses.push((await transport.fetch(endpoint, { method: 'GET' })).status);
    expect(statuses).toEqual([404, 404, 404, 404]);
    // … and 200 there only with this DSN's public key, in the query string or in X-Sentry-Auth.
    const auth = `Sentry sentry_version=7, sentry_key=${PUBLIC_KEY}, sentry_client=qa13d/fake`;
    const otherKey = 'feedfacefeedfacefeedfacefeedface';
    async function post(url: string, headers: Record<string, string> = {}): Promise<number> {
      const response = await transport.fetch(url, { method: 'POST', body: '{}', headers });
      return response.status;
    }
    const authStatuses = [
      await post(endpoint),
      await post(`${endpoint}?sentry_key=${otherKey}`),
      await post(`${endpoint}?sentry_version=7&sentry_key=${PUBLIC_KEY}`),
      await post(endpoint, { 'X-Sentry-Auth': auth }),
    ];
    expect(authStatuses).toEqual([401, 401, 200, 200]);
  },
);
