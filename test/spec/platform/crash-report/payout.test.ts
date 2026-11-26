// [AC-QA-13d#3] payout has no public egress (ADR-0001 §4.2 #20): it reports only when the DSN host
// is internal. A public host (name or address, including addresses just outside the private ranges
// and names that merely contain a private address) → not initialised (no client, no hook, nothing
// sent) and exactly one warn line, not quoting the DSN; a private-range IPv4 host (10/8,
// 172.16/12, 192.168/16) → initialised and reports to that host. The other entries are not
// restricted. Reports go to a fake fetch; nothing reaches the network.
import { expect, it } from 'vitest';
import { startCrashReporting } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  FakeProcess,
  PUBLIC_KEY,
  WARN,
  configOf,
  dsnFor,
  fakeFetch,
  memoryLogger,
  sentEvents,
  type Entry,
} from './kit.ts';

const PUBLIC_HOSTS = [
  'glitchtip.example.com',
  '8.8.8.8',
  '203.0.113.7',
  '172.32.0.5',
  '172.15.255.1',
  '192.169.1.20',
  '11.0.0.1',
  '10.0.0.1.nip.io',
  '172-20-0-5.sslip.io',
] as const;

const INTERNAL_HOSTS = [
  '172.20.0.5:8000',
  '172.16.0.1',
  '172.31.255.254',
  '10.1.2.3',
  '192.168.1.20',
] as const;

it.each(PUBLIC_HOSTS.map((host) => [host]))(
  '[AC-QA-13d#3] payout with a public DSN host %s: not initialised, one warn line, nothing sent',
  async (host: string) => {
    const dsn = dsnFor(host);
    const { logger, lines, records } = memoryLogger('payout');
    const transport = fakeFetch();
    const fake = new FakeProcess();
    const reporter = await startCrashReporting({
      entry: 'payout',
      config: configOf({ [DSN_VAR]: dsn }),
      logger,
      fetch: transport.fetch,
      process: fake,
    });
    expect(reporter.enabled).toBe(false);
    expect(fake.hookCount()).toBe(0);
    reporter.captureException(new Error('qa13d payout public capture'));
    await reporter.flush(500);
    await reporter.close(500);
    expect(transport.requests).toEqual([]);
    expect(records().filter((record) => record.level === WARN)).toHaveLength(1);
    expect(records().filter((record) => record.level > WARN)).toEqual([]);
    expect(lines.join('\n')).not.toContain(dsn);
    expect(lines.join('\n')).not.toContain(PUBLIC_KEY);
  },
);

it.each(INTERNAL_HOSTS.map((host) => [host]))(
  '[AC-QA-13d#3] payout with a private-range DSN host %s: initialised, reports to that host',
  async (host: string) => {
    const { logger, records } = memoryLogger('payout');
    const transport = fakeFetch();
    const fake = new FakeProcess();
    const reporter = await startCrashReporting({
      entry: 'payout',
      config: configOf({ [DSN_VAR]: dsnFor(host, 'http') }),
      logger,
      fetch: transport.fetch,
      process: fake,
    });
    try {
      expect(reporter.enabled).toBe(true);
      reporter.captureException(new Error('qa13d payout internal capture'));
      await reporter.flush(2_000);
    } finally {
      await reporter.close(1_000);
    }
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(transport.requests.every((request) => new URL(request.url).host === host)).toBe(true);
    const events = await sentEvents(transport.requests);
    const values = events.map((event) => event.exception?.values?.[0]?.value);
    expect(values).toEqual(['qa13d payout internal capture']);
    expect(records().filter((record) => record.level >= WARN)).toEqual([]);
  },
);

it.each((['api', 'stream', 'admin', 'worker'] as const).map((entry) => [entry]))(
  '[AC-QA-13d#3] %s is not restricted: a public DSN host is initialised and reported to',
  async (entry: Entry) => {
    const { logger } = memoryLogger(entry);
    const transport = fakeFetch();
    const reporter = await startCrashReporting({
      entry,
      config: configOf({ [DSN_VAR]: dsnFor('glitchtip.example.com') }),
      logger,
      fetch: transport.fetch,
      process: new FakeProcess(),
    });
    try {
      expect(reporter.enabled).toBe(true);
      reporter.captureException(new Error(`qa13d ${entry} public capture`));
      await reporter.flush(2_000);
    } finally {
      await reporter.close(1_000);
    }
    const events = await sentEvents(transport.requests);
    expect(events).toHaveLength(1);
    const url = new URL(transport.requests[0]?.url ?? 'http://none');
    expect(url.host).toBe('glitchtip.example.com');
  },
);
