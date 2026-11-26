import { expect, it } from 'vitest';
import { loadConfig } from '../config/config.ts';
import { createRootLogger } from '../logging/logger.ts';
import { isPrivateIPv4Host, startCrashReporting, type CrashProcess } from './index.ts';

const KEY = 'unitPayoutPublicKey';

function memoryLogger(): { logger: ReturnType<typeof createRootLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'payout', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

function fakeProcess(): CrashProcess & { readonly hooks: () => number } {
  let hooks = 0;
  return {
    on: () => void (hooks += 1),
    off: () => void (hooks -= 1),
    exit: () => undefined,
    hooks: () => hooks,
  };
}

it.each([
  ['a host name', 'glitchtip.unit.test'],
  ['an internal-looking host name', 'glitchtip.corp.internal'],
  ['a public IPv4 address', '203.0.113.7'],
])(
  '[AC-QA-13d#3] payout with %s: not initialised, one warn naming only the variable and the reason',
  async (_name: string, host: string) => {
    const dsn = `http://${KEY}@${host}/3`;
    const { logger, lines } = memoryLogger();
    const calls: string[] = [];
    const proc = fakeProcess();
    const reporter = await startCrashReporting({
      entry: 'payout',
      config: loadConfig({ APP_ENV: 'test', CRASH_REPORT_DSN: dsn }),
      logger,
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      process: proc,
    });
    expect(reporter.enabled).toBe(false);
    expect(proc.hooks()).toBe(0);
    reporter.captureException(new Error('unit payout capture'));
    await reporter.close(200);
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 40,
      variable: 'CRASH_REPORT_DSN',
      reason: 'payout_dsn_host_not_private_ipv4',
    });
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain(host);
  },
);

it('[AC-QA-13d#3] payout with a private-range IPv4 host: initialised and sends to that host', async () => {
  const { logger, lines } = memoryLogger();
  const calls: string[] = [];
  const proc = fakeProcess();
  const reporter = await startCrashReporting({
    entry: 'payout',
    config: loadConfig({ APP_ENV: 'test', CRASH_REPORT_DSN: ` http://${KEY}@172.20.0.5:8000/3/ ` }),
    logger,
    fetch: (input) => {
      calls.push(String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
    process: proc,
  });
  try {
    expect(reporter.enabled).toBe(true);
    expect(proc.hooks()).toBeGreaterThan(0);
    reporter.captureException(new Error('unit payout internal capture'));
    await reporter.flush(1_000);
  } finally {
    await reporter.close(500);
  }
  expect(calls).toEqual(['http://172.20.0.5:8000/api/3/envelope/']);
  expect(lines.filter((line) => (JSON.parse(line) as { level: number }).level >= 40)).toEqual([]);
});

it('[AC-QA-13d#3] only private-range IPv4 literals count', () => {
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20']) {
    expect(isPrivateIPv4Host(host)).toBe(true);
  }
  for (const host of ['172.32.0.5', '11.0.0.1', '10.0.0.1.nip.io', 'glitchtip.corp.internal']) {
    expect(isPrivateIPv4Host(host)).toBe(false);
  }
});

it('[AC-QA-13d#1] a hand-built config with a DSN the SDK would refuse is disabled, DSN not logged', async () => {
  const { logger, lines } = memoryLogger();
  const proc = fakeProcess();
  const config = loadConfig({ APP_ENV: 'test' });
  const dsn = `https://${KEY}-x@glitchtip.unit.test/3`;
  const reporter = await startCrashReporting({
    entry: 'api',
    config: { ...config, crashReport: { dsn } },
    logger,
    process: proc,
  });
  expect(reporter.enabled).toBe(false);
  expect(proc.hooks()).toBe(0);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ variable: 'CRASH_REPORT_DSN' });
  expect(lines.join('\n')).not.toContain(KEY);
});

it.each([
  [
    'a %20 prefix',
    ' http://unitPayoutPublicKey@10.4.0.9/error tracking/3 ',
    'http://10.4.0.9/error%20tracking/api/3/envelope/',
  ],
  [
    'a multi-level prefix',
    'http://unitPayoutPublicKey@10.4.0.9:9000/ops/glitch-tip/3/',
    'http://10.4.0.9:9000/ops/glitch-tip/api/3/envelope/',
  ],
  ['no prefix', 'http://unitPayoutPublicKey@10.4.0.9/3', 'http://10.4.0.9/api/3/envelope/'],
])(
  '[AC-QA-13d#1] payout with %s: accepted by config and SDK, private host, envelope path kept',
  async (_name: string, dsn: string, endpoint: string) => {
    const { logger, lines } = memoryLogger();
    const calls: string[] = [];
    const proc = fakeProcess();
    const reporter = await startCrashReporting({
      entry: 'payout',
      config: loadConfig({ APP_ENV: 'test', CRASH_REPORT_DSN: dsn }),
      logger,
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      process: proc,
    });
    try {
      expect(reporter.enabled).toBe(true);
      reporter.captureException(new Error('unit payout prefix capture'));
      await reporter.flush(1_000);
    } finally {
      await reporter.close(500);
    }
    expect(calls).toEqual([endpoint]);
    expect(lines.filter((line) => (JSON.parse(line) as { level: number }).level >= 40)).toEqual([]);
  },
);
