import { expect, it } from 'vitest';
import { createSwitchApi, type HttpRequest } from '../../../../infra/drills/switches/drill.ts';
import { LOCAL, row, STEP_UP, TOKEN } from './fixture.ts';

it('[AC-QA-05c#23] adminListKillSwitches 使用 GET，读齐分页，保留值与版本', async () => {
  const requests: HttpRequest[] = [];
  const api = createSwitchApi({
    target: LOCAL,
    bearer: TOKEN,
    stepUpToken: STEP_UP,
    transport: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('page_size'));
      expect(page).toBeGreaterThanOrEqual(1);
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
      // A full first page forces discovery of a requested key beyond it.
      const items =
        page === 1
          ? Array.from({ length: size }, (_, i) => row(`agent.tools.tool${i}.enabled`))
          : [row('agent.enabled', true, 42)];
      return {
        status: 200,
        body: {
          code: 0,
          msg: '',
          trace_id: 'qa05c',
          data: { items, page, page_size: size, total: size + 1 },
        },
      };
    },
  });
  const items = await api.list();
  expect(requests).toHaveLength(2);
  expect(items.at(-1)).toEqual(row('agent.enabled', true, 42));
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/admin/v1/kill-switches');
    expect(new URL(request.url).origin).toBe(LOCAL.baseUrl);
    expect(request.redirect).toBe('error');
    expect(request.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(request.url).not.toContain(TOKEN);
    expect(request.url).not.toContain(STEP_UP);
  }
});

it('[AC-QA-05c#24] adminUpdateKillSwitch 使用 PUT、expected_version 和二次验证头', async () => {
  const requests: HttpRequest[] = [];
  const api = createSwitchApi({
    target: LOCAL,
    bearer: TOKEN,
    stepUpToken: STEP_UP,
    transport: async (request) => {
      requests.push(request);
      return {
        status: 200,
        body: { code: 0, msg: '', trace_id: 'qa05c', data: row('agent.enabled', false, 43) },
      };
    },
  });
  const updated = await api.update('agent.enabled', false, 42);
  expect(updated.version).toBe(43);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'PUT',
    url: `${LOCAL.baseUrl}/admin/v1/kill-switches/agent.enabled`,
    redirect: 'error',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Step-Up-Token': STEP_UP },
    body: { value: false, expected_version: 42 },
  });
  expect(
    Object.keys(requests[0]!.body as object).every((key) =>
      ['value', 'expected_version', 'reason'].includes(key),
    ),
  ).toBe(true);
  expect(JSON.stringify(requests[0]!.body)).not.toContain(TOKEN);
  expect(Object.keys(requests[0]!.headers).map((key) => key.toLowerCase())).not.toContain(
    'idempotency-key',
  );
});

it.each([10001, 10003, 10403, 20001, 20902])(
  '[AC-QA-05c#25] 契约错误码 %i 不当成功，不盲目重试写入',
  async (code) => {
    const requests: HttpRequest[] = [];
    const api = createSwitchApi({
      target: LOCAL,
      bearer: TOKEN,
      stepUpToken: STEP_UP,
      transport: async (request) => {
        requests.push(request);
        return {
          status: 409,
          body: { code, msg: `${TOKEN} ${STEP_UP}`, data: {}, trace_id: 'qa05c' },
        };
      },
    });
    const error: unknown = await api
      .update('agent.enabled', false, 7)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(STEP_UP);
    expect(requests).toHaveLength(1);
  },
);

it('[AC-QA-05c#26] 不能跟随重定向把管理凭据带到非白名单地址', async () => {
  const requests: HttpRequest[] = [];
  const api = createSwitchApi({
    target: LOCAL,
    bearer: TOKEN,
    stepUpToken: STEP_UP,
    transport: async (request) => {
      requests.push(request);
      return { status: 302, body: { location: 'https://prod.example.invalid' } };
    },
  });
  await expect(api.list()).rejects.toBeInstanceOf(Error);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.redirect).toBe('error');
});

it.each(['payout.enabled', 'withdraw.auto_payout.enabled', 'agent.model_route', 'sms.provider'])(
  '[AC-QA-05c#27] 直接调用 HTTP 适配器也不能写入禁止项 %s',
  async (key) => {
    const requests: HttpRequest[] = [];
    const api = createSwitchApi({
      target: LOCAL,
      bearer: TOKEN,
      stepUpToken: STEP_UP,
      transport: async (request) => {
        requests.push(request);
        throw new Error('unexpected request');
      },
    });
    await expect(api.update(key, false, 7)).rejects.toBeInstanceOf(Error);
    expect(requests).toEqual([]);
  },
);
