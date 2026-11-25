import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import {
  handleAlertmanagerWebhook,
  serve,
  type ForwarderOptions,
  type Receiver,
} from '../../../../infra/monitoring/forwarder/webhook.ts';

const GROUP = '{fund="true"}:{alertname="CouliWithdrawalResultUnknown", app_id="fixture-a"}';
const OTHER_GROUP = GROUP.replace('fixture-a', 'fixture-b');
const WINDOW_MS = 30 * 60_000;
const ROBOTS = {
  finance: 'https://finance.example.invalid/send?key=fixture-success-finance',
  oncall: 'https://oncall.example.invalid/send?key=fixture-success-oncall',
};
const FILES = { finance: '/fixture/finance-webhook', oncall: '/fixture/oncall-webhook' };
let fixtureRun = 0;

function robotOk(): Response {
  return Response.json({ errcode: 0 });
}

function webhookBody(
  receiver: Receiver,
  groupKey: string,
  status: 'firing' | 'resolved',
  summary = '打款结果待确认',
) {
  return {
    version: '4',
    receiver,
    groupKey,
    status,
    alerts: [
      {
        // A firing group can contain resolved alerts. Deduplication uses the envelope status.
        status: 'resolved',
        labels: { alertname: 'CouliWithdrawalResultUnknown', severity: 'critical' },
        annotations: { summary },
        startsAt: '2026-11-25T01:00:00Z',
        endsAt: '2026-11-25T01:02:00Z',
      },
      {
        status,
        labels: { alertname: 'CouliWithdrawalResultUnknown', severity: 'critical' },
        startsAt: '2026-11-25T01:03:00Z',
      },
    ],
  };
}

function forwarder(deduplicationCapacity = 100) {
  const groupPrefix = `fixture-${++fixtureRun}-`;
  let now = Date.parse('2026-11-25T01:08:00Z');
  const options = {
    webhookFiles: FILES,
    readWebhookFile: vi.fn(async (path: string) => {
      expect(Object.values(FILES)).toContain(path);
      return path === FILES.finance ? ROBOTS.finance : ROBOTS.oncall;
    }),
    fetch: vi.fn<typeof fetch>().mockImplementation(async () => robotOk()),
    sleep: vi.fn<ForwarderOptions['sleep']>().mockResolvedValue(undefined),
    timeoutSignal: vi.fn<ForwarderOptions['timeoutSignal']>(() => new AbortController().signal),
    now: () => now,
    deduplicationCapacity,
  } satisfies ForwarderOptions;

  return {
    options,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    send: (
      groupKey = GROUP,
      status: 'firing' | 'resolved' = 'firing',
      receiver: Receiver = 'finance',
      summary?: string,
    ) => {
      const scopedGroup = groupKey.replace('fixture-', groupPrefix);
      return handleAlertmanagerWebhook(
        new Request(`http://127.0.0.1/${receiver}`, {
          method: 'POST',
          body: JSON.stringify(webhookBody(receiver, scopedGroup, status, summary)),
        }),
        options,
      );
    },
  };
}

it('[AC-B1-25d#1] 同组同状态只发一次，恢复、触发和其他组分别送达', async () => {
  const { send, options } = forwarder();

  for (const [groupKey, status, pushes, summary] of [
    [GROUP, 'firing', 1],
    [GROUP, 'firing', 1, '告警内容已有更新'],
    [GROUP, 'resolved', 2],
    [GROUP, 'resolved', 2],
    [GROUP, 'firing', 2],
    [OTHER_GROUP, 'firing', 3],
  ] as const) {
    expect((await send(groupKey, status, 'finance', summary)).status).toBe(200);
    expect(options.fetch).toHaveBeenCalledTimes(pushes);
  }
});

it('[AC-B1-25d#2] 同一个 groupKey 发给财务和值班时各自去重', async () => {
  const { send, options } = forwarder();

  for (const receiver of ['finance', 'oncall', 'finance', 'oncall'] as const) {
    expect((await send(GROUP, 'firing', receiver)).status).toBe(200);
  }
  expect(options.fetch.mock.calls.map((call) => new Request(...call).url)).toEqual([
    ROBOTS.finance,
    ROBOTS.oncall,
  ]);
});

it('[AC-B1-25d#3] 30 分钟内的重复送达不续期，到期后可再推送', async () => {
  const { send, options, advance } = forwarder();

  expect((await send()).status).toBe(200);
  advance(WINDOW_MS - 1);
  expect((await send()).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(1);
  advance(1);
  expect((await send()).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(2);
  expect((await send()).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(2);
});

it('[AC-B1-25d#4] 机器人超时在同一次请求内照常重试，成功后才挡重复送达', async () => {
  const { send, options } = forwarder();
  const expired = AbortSignal.abort(new DOMException('fixture timeout', 'TimeoutError'));
  options.timeoutSignal.mockReturnValueOnce(expired);
  options.fetch.mockImplementation(async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    return robotOk();
  });

  expect((await send()).status).toBe(200);
  expect(options.timeoutSignal.mock.calls).toEqual([[5000], [5000]]);
  expect(options.fetch).toHaveBeenCalledTimes(2);
  expect(options.sleep).toHaveBeenCalledTimes(1);
  expect((await send()).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(2);
});

it('[AC-B1-25d#5] 所有推送尝试均失败时仍允许 Alertmanager 重新送达', async () => {
  const { send, options } = forwarder();
  options.fetch.mockImplementation(async () => new Response(null, { status: 503 }));

  expect((await send()).status).toBe(502);
  expect(options.fetch).toHaveBeenCalledTimes(4);
  options.fetch.mockImplementation(async () => robotOk());

  expect((await send()).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(5);
  expect((await send()).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(5);
});

it('[AC-B1-25d#6] 达到条数上限时淘汰最旧的去重记录', async () => {
  const { send, options, advance } = forwarder(2);
  const thirdGroup = GROUP.replace('fixture-a', 'fixture-c');

  expect((await send()).status).toBe(200);
  advance(1);
  expect((await send(OTHER_GROUP)).status).toBe(200);
  advance(1);
  expect((await send(thirdGroup)).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(3);
  expect((await send(OTHER_GROUP)).status).toBe(200);
  expect((await send(thirdGroup)).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(3);
  expect((await send()).status).toBe(200);
  expect(options.fetch).toHaveBeenCalledTimes(4);
});

it('[AC-B1-25d#7] 并发收到同组同状态的 webhook 时只推送一次', async () => {
  const { send, options } = forwarder();
  options.fetch.mockImplementation(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return robotOk();
  });

  const responses = await Promise.all([send(), send()]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(options.fetch).toHaveBeenCalledTimes(1);
});

async function serveFinance(options: ForwarderOptions, body: unknown) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url: '/finance',
  });
  const res = { writeHead: vi.fn<(status: number) => unknown>().mockReturnThis(), end: vi.fn() };
  await serve(req as unknown as IncomingMessage, res as unknown as ServerResponse, options);
  return res.writeHead.mock.calls.map(([status]) => status);
}

it('[AC-B1-25d#8] 首次推送成功及去重应答的日志均不含 Webhook 地址或 key', async () => {
  const { options } = forwarder();
  const url = ROBOTS.finance;
  const key = new URL(url).searchParams.get('key')!;
  const detail = `fixture ${url} ${key}`;
  const body = webhookBody('finance', GROUP, 'firing', detail);
  options.fetch.mockImplementation(async () => Response.json({ errcode: 0, errmsg: detail }));

  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const diagnostics = console as unknown as Record<string, (...values: unknown[]) => void>;
  const consoleSpies = Object.keys(diagnostics)
    .filter((name) => typeof diagnostics[name] === 'function')
    .map((name) => vi.spyOn(diagnostics, name).mockReturnValue(undefined));
  try {
    const statuses = [await serveFinance(options, body), await serveFinance(options, body)];
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(statuses).toEqual([[200], [200]]);
    const decode = ([chunk]: [string | Uint8Array, ...unknown[]]) =>
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    const stdoutText = stdout.mock.calls.map(decode).join('');
    expect(stdoutText).toMatch(/"status"\s*:\s*200/);
    const stderrText = stderr.mock.calls.map(decode).join('');
    const consoleText = inspect(
      consoleSpies.flatMap((spy) => spy.mock.calls),
      { depth: null, maxStringLength: null, maxArrayLength: null, customInspect: false },
    );
    expect(`${stdoutText}${stderrText}${consoleText}`).not.toContain(url);
    expect(`${stdoutText}${stderrText}${consoleText}`).not.toContain(key);
    expect(options.fetch).toHaveBeenCalledTimes(1);
  } finally {
    for (const spy of [...consoleSpies, stderr, stdout]) spy.mockRestore();
  }
});
