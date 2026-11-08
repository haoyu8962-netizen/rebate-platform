// Real database, FieldCrypto and admin sessions. All execution belongs to the isolated runner.
import { randomInt, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { grant, seed, type Seed } from '../../admin/accounts/kit.ts';
import {
  fixture,
  signedIn,
  totp,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import { REVEAL, validate } from './schema.ts';

export const REASON = '用户来电核对注册手机号';
export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

export function mounted(app: HttpApp): boolean {
  const server = app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  return server.hasRoute({ method: 'POST', url: REVEAL.replace('{user_id}', ':user_id') });
}

export async function setup(h: Harness) {
  const f = await fixture(h);
  // Every integration case is red before reveal exists, including negative and entry checks.
  expect(mounted(f.app), 'admin 入口必须挂载真实 reveal 路由').toBe(true);
  const appId = `f1-07a-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  f.overrides.logger.info({ event: 'pii_test_capture_ready' }, 'capture ready');
  return { ...f, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export async function member(h: Harness, f: Setup, permissions: readonly string[]) {
  const who = await seed(h, f.appId);
  if (permissions.length !== 0) await grant(h, who, f.actor, permissions);
  const session = await signedIn(f, who);
  return { who, token: session.admin_token };
}

export async function stepUp(f: Setup, who: Seed = f.actor, token = f.token) {
  f.clock.advanceMs(30_000);
  // The previous (already consumed) step is still in the verifier's [-1,+1] window and the
  // verifier keeps the earliest match, so skip steps whose code equals the previous one.
  while (totp(who.secret, f.clock, -1) === totp(who.secret, f.clock)) f.clock.advanceMs(30_000);
  const response = await f.post(
    '/step-up',
    { tier: 'totp', code: totp(who.secret, f.clock) },
    { authorization: `Bearer ${token}` },
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  const data = response.json<{ data: { step_up_token: string } }>().data;
  expect(typeof data.step_up_token).toBe('string');
  return data.step_up_token;
}

export async function user(h: Harness, appId: string, bound = true) {
  const id = randomUUID();
  // Synthetic plaintext exists only in memory during the isolated test, not in fixtures.
  const phone = bound ? `138${String(randomInt(100_000_000)).padStart(8, '0')}` : null;
  const cipher = phone === null ? null : Buffer.from(h.fields.encrypt(phone, 'users.phone'));
  const hmac = phone === null ? null : h.fields.blindIndex(phone, 'users.phone');
  await h.db
    .insertInto('users')
    .values({
      id,
      app_id: appId,
      nickname: '测试用户',
      avatar: 'https://example.invalid/avatar.png',
      phone_cipher: cipher,
      phone_hmac: hmac,
      invite_code: `i-${id}`,
      attr_code: `a-${id}`,
      level: 'L1',
      parent_id: null,
      parent_bind_source: null,
      parent_bound_at: null,
      nickname_change_month: null,
      register_method: bound ? 'phone' : 'wechat',
      registered_channel: 'test',
      deleted_reason: null,
    })
    .execute();
  return { id, phone, cipher, hmac };
}
export type User = Awaited<ReturnType<typeof user>>;

export function reveal(
  f: Pick<Setup, 'app' | 'token'>,
  id: string,
  options: {
    token?: string | null;
    stepUp?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
) {
  const token = options.token === undefined ? f.token : options.token;
  return f.app.inject({
    method: 'POST',
    url: REVEAL.replace('{user_id}', id),
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(options.stepUp === undefined ? {} : { 'x-step-up-token': options.stepUp }),
      ...options.headers,
    },
    payload: JSON.stringify(options.body ?? { field: 'phone', reason: REASON }),
    remoteAddress: '127.0.0.1',
  });
}

export async function success(response: Response, target: User) {
  expect(response.statusCode).toBe(200);
  expect(response.json<Schema<'AdminUserRevealResponse'>>()).toEqual({
    code: 0,
    msg: '',
    data: { user_id: target.id, field: 'phone', value: target.phone },
    trace_id: TRACE,
  });
  expect(response.headers['cache-control']).toBe('no-store');
  await validate(response);
}

export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 10001 ? 401 : code === 10003 || code === 10403 ? 403 : code === 50001 ? 500 : 400,
  );
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response);
}

export const audits = (h: Harness, f: Setup) =>
  h.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId).orderBy('id').execute();

export function assertAudit(
  row: Awaited<ReturnType<typeof audits>>[number],
  f: Setup,
  actor: Seed,
  target: User,
  reason = REASON,
) {
  expect(row).toMatchObject({ app_id: f.appId, admin_id: actor.id, action: 'user_pii_reveal' });
  expect(row.at.toISOString()).toBe(f.clock.now().toISOString());
  const facts = { ...(row.before as object | null), ...(row.after as object | null) } as Record<
    string,
    unknown
  >;
  expect(row.target === target.id || facts.user_id === target.id).toBe(true);
  expect(facts.field).toBe('phone');
  expect(facts.reason).toBe(reason);
  // Inspect nested snapshots too: hiding the value under another key is still a leak.
  const text = JSON.stringify(row, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  if (target.phone !== null) expect(text).not.toContain(target.phone);
  if (target.cipher !== null) expect(text).not.toContain(target.cipher.toString('utf8'));
  if (target.hmac !== null) expect(text).not.toContain(target.hmac);
  expect(text).not.toMatch(/"(?:value|phone|phone_cipher|phone_hmac)"\s*:/);
}

export function noPlaintext(f: Setup, target: User, response?: Response) {
  expect(f.lines.length, '日志捕获器必须启用').toBeGreaterThan(0);
  if (target.phone !== null) {
    expect(f.lines.join('\n')).not.toContain(target.phone);
    if (response !== undefined) expect(JSON.stringify(response.json())).not.toContain(target.phone);
  }
}
