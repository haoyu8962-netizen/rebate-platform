import { expect, it, vi } from 'vitest';
import { handleAlertmanagerWebhook } from '../../../../infra/monitoring/forwarder/webhook.ts';
import { configuration, list, record, string } from '../alerting/kit.ts';

// B1-25c local acceptance points from D10-2605 / D10-2612. All outbound calls use doubles.
const RECEIVERS = ['finance', 'oncall'] as const;
const FILES = { finance: '/node/finance-webhook', oncall: '/node/oncall-webhook' } as const;
const ROBOTS = {
  finance: 'https://finance.example.invalid/send?key=fixture-finance',
  oncall: 'https://oncall.example.invalid/send?key=fixture-oncall',
} as const;
const PRIVATE = {
  phone: '+86 138-0000-0001',
  id: '11010599991231002X',
  card: '6222-0200-0000-0000-000',
  account: 'fixture.payee@example.invalid',
  login: 'fixture-wallet-login',
  token: 'fixture-access-value',
};
const OMIT = {
  app: 'internal-app-marker',
  description: 'internal-description-marker',
  url: 'https://internal.example.invalid/detail',
  fingerprint: 'internal-fingerprint-marker',
};
const SUMMARY = [
  '转账结果待核对',
  PRIVATE.phone,
  PRIVATE.id,
  PRIVATE.card,
  PRIVATE.account,
  `payee_account=${PRIVATE.login}`,
  `access_token=${PRIVATE.token}`,
].join(' ');

const ALERTS = [
  {
    status: 'firing',
    labels: { alertname: 'CouliWithdrawalResultUnknown', severity: 'critical', app_id: OMIT.app },
    annotations: {
      summary: SUMMARY,
      description: OMIT.description,
    },
    startsAt: '2031-04-05T12:34:56Z',
    generatorURL: OMIT.url,
    fingerprint: OMIT.fingerprint,
  },
  {
    status: 'resolved',
    labels: { alertname: 'CouliWithdrawalResultUnknown', severity: 'critical' },
    annotations: { summary: '转账结果已核对' },
    startsAt: '2031-04-05T12:35:57Z',
    endsAt: '2031-04-05T12:41:58Z',
  },
];

function hookRequest(url: string, receiver: 'finance' | 'oncall'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: '4',
      receiver,
      status: 'firing',
      alerts: ALERTS,
      externalURL: OMIT.url,
    }),
  });
}

function robotOk(): Response {
  return Response.json({ errcode: 0, errmsg: 'ok' });
}

function dependencies() {
  const readWebhookFile = vi.fn(async (path: string) => {
    if (path === FILES.finance) return `${ROBOTS.finance}\n`;
    if (path === FILES.oncall) return `${ROBOTS.oncall}\n`;
    throw new Error('unexpected test file path');
  });
  const timeoutSignal = vi.fn<(ms: number) => AbortSignal>(() => new AbortController().signal);
  return {
    webhookFiles: FILES,
    readWebhookFile,
    fetch: vi.fn<typeof fetch>().mockImplementation(async () => robotOk()),
    sleep: vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined),
    timeoutSignal,
  };
}

async function checkReceiver(receiver: (typeof RECEIVERS)[number]) {
  const config = configuration();
  const matching = config.receivers.find((entry) => entry['name'] === receiver);
  const target = record(matching, receiver);
  const hooks = list(target['webhook_configs'], receiver);
  expect(hooks).toHaveLength(1);
  const hook = record(hooks[0], receiver);
  expect(hook['send_resolved'] ?? true).toBe(true);
  const url = new URL(string(hook['url'], receiver));
  expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1(?::[1-9]\d*)?$/);
  expect(url.pathname).toBe(`/${receiver}`);
  expect(url.search).toBe('');

  const options = dependencies();
  const response = await handleAlertmanagerWebhook(hookRequest(url.href, receiver), options);
  expect(response.ok).toBe(true);
  expect(options.readWebhookFile).toHaveBeenCalledWith(FILES[receiver]);
  expect(options.fetch).toHaveBeenCalledTimes(1);
  const call = options.fetch.mock.calls[0]!;
  const outbound = new Request(...call);
  expect(outbound.url).toBe(ROBOTS[receiver]);
  expect(outbound.method).toBe('POST');
  expect(outbound.headers.get('content-type')).toContain('application/json');
  expect(await response.text()).not.toContain(ROBOTS[receiver]);
}

it.each(RECEIVERS)('[AC-B1-25c#1] %s 告警送到对应群机器人', checkReceiver);

it('[AC-B1-25c#2] Markdown 保留触发和恢复告警并去除敏感信息', async () => {
  const options = dependencies();
  const request = hookRequest('http://127.0.0.1/finance', 'finance');
  const response = await handleAlertmanagerWebhook(request, options);

  expect(response.ok).toBe(true);
  expect(options.fetch).toHaveBeenCalledTimes(1);
  const outbound = new Request(...options.fetch.mock.calls[0]!);
  const payload: unknown = await outbound.json();
  expect(payload).toEqual({ msgtype: 'markdown', markdown: { content: expect.any(String) } });
  const markdown = record(record(payload, 'robot payload')['markdown'], 'markdown');
  const content = string(markdown['content'], 'content');
  for (const field of [
    'CouliWithdrawalResultUnknown',
    'critical',
    'firing',
    'resolved',
    '转账结果待核对',
    '转账结果已核对',
  ]) {
    expect(content).toContain(field);
  }
  // Permit either exact UTC time or local +08:00 rendering and optional seconds.
  expect(content).toMatch(/(?:12|20):34/);
  expect(content).toMatch(/(?:12|20):(?:35|41)/);
  for (const forbidden of [...Object.values(PRIVATE), ...Object.values(OMIT), ROBOTS.finance]) {
    expect(content).not.toContain(forbidden);
  }
  // A display mask that preserves part of a phone or card is insufficient for alerts.
  expect(content).not.toMatch(/138|6222|110105/);
});

it('[AC-B1-25c#3] HTTP 200 的业务失败也要退避重试', async () => {
  const options = dependencies();
  const limited = Response.json({ errcode: 45009, errmsg: 'fixture temporary failure' });
  options.fetch.mockResolvedValueOnce(limited);
  const request = hookRequest('http://127.0.0.1/oncall', 'oncall');
  const response = await handleAlertmanagerWebhook(request, options);
  expect(response.ok).toBe(true);
  expect(options.fetch).toHaveBeenCalledTimes(2);
  expect(options.sleep).toHaveBeenCalledTimes(1);
  expect(options.sleep.mock.calls[0]![0]).toBeGreaterThan(0);
  for (const call of options.fetch.mock.calls) {
    expect(new Request(...call).url).toBe(ROBOTS.oncall);
  }
});

it('[AC-B1-25c#4] 持续推送失败最多重试三次并返回失败', async () => {
  const options = dependencies();
  const unavailable = new Response(ROBOTS.finance, { status: 503 });
  options.fetch.mockImplementation(async () => unavailable.clone());
  const request = hookRequest('http://127.0.0.1/finance', 'finance');
  const response = await handleAlertmanagerWebhook(request, options);
  expect(response.ok).toBe(false);
  expect(options.fetch.mock.calls.length).toBeGreaterThan(1);
  expect(options.fetch.mock.calls.length).toBeLessThanOrEqual(4);
  expect(options.sleep).toHaveBeenCalledTimes(options.fetch.mock.calls.length - 1);
  for (const [delay] of options.sleep.mock.calls) expect(delay).toBeGreaterThan(0);
  expect(await response.text()).not.toContain(ROBOTS.finance);
});

it('[AC-B1-25c#5] 每次推送独立计五秒超时', async () => {
  const options = dependencies();
  const timedOut = AbortSignal.abort(new DOMException('fixture timeout', 'TimeoutError'));
  options.timeoutSignal.mockReturnValueOnce(timedOut);
  const signals: (AbortSignal | null | undefined)[] = [];
  options.fetch.mockImplementation(async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signals.push(signal);
    signal?.throwIfAborted();
    return robotOk();
  });

  const request = hookRequest('http://127.0.0.1/finance', 'finance');
  const response = await handleAlertmanagerWebhook(request, options);
  expect(response.ok).toBe(true);
  expect(options.timeoutSignal.mock.calls).toEqual([[5000], [5000]]);
  expect(signals.map((signal) => signal?.aborted)).toEqual([true, false]);
  expect(signals[0]).not.toBe(signals[1]);
});
