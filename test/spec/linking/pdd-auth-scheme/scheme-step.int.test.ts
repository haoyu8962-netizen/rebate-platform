import { createHash, createHmac } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import type { PddAuthorityUrl } from '../../../../apps/api/src/modules/union/index.ts';
import {
  authorityHarness,
  expectAuthSteps,
  expectNoState,
  issued,
  planValues,
  refused,
  type AuthJumpPlan,
  type InjectResponse,
} from '../pdd-auth-link/kit.ts';

// B1-06zfa (FU-PDD-AUTH-SCHEME-E2E, D10-662 / D10-1061 ③): when the device says the Pinduoduo App
// is installed (true) or does not know (unknown), the authorization jump of both exits —
// GET /v1/unions/pdd/auth-url and the not-filed open's 30111 auth_jump — has a scheme step that is
// the upstream schema_url exactly (never an App scheme wrapping the web address), its h5 step is
// mobile_short_url, and no other step carries the scheme raw or encoded.
//
// The kit (../pdd-auth-link/kit.ts) sends installed=false on both exits. Only the installed value of
// a request is changed here, on the way into the kit's own api entry: the auth-url query string, and
// the open body (re-signed with the device's install secret by the same algorithm the kit signs
// with, keeping its timestamp and nonce). Nothing else of the request or the entry is touched.

type Installed = 'true' | 'unknown';

interface InjectInput {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  payload?: string;
  remoteAddress: string;
}

interface Injectable {
  inject(input: InjectInput): Promise<InjectResponse>;
}

let installed: Installed | null = null;
const secrets = new Map<string, string>();

function rewrite(input: InjectInput): InjectInput {
  if (installed === null) return input;
  const path = input.url.split('?')[0]!;
  if (input.method === 'GET' && /^\/v1\/unions\/[a-z]+\/auth-url$/.test(path)) {
    expect(input.url).toContain('installed=false');
    return { ...input, url: input.url.replace('installed=false', `installed=${installed}`) };
  }
  if (input.method === 'POST' && /^\/v1\/links\/[^/]+\/open$/.test(path)) {
    const body = JSON.parse(String(input.payload)) as Record<string, unknown>;
    expect(body['installed']).toBe('false');
    const payload = JSON.stringify({ ...body, installed });
    const secret = secrets.get(String(input.headers['x-device-id']));
    expect(secret, 'install secret of the signing device').toEqual(expect.any(String));
    const timestamp = String(input.headers['x-timestamp']);
    const nonce = String(input.headers['x-nonce']);
    const digest = createHash('sha256').update(payload).digest('hex');
    const sign = createHmac('sha256', String(secret))
      .update(['POST', path, timestamp, nonce, digest].join('\n'))
      .digest('hex');
    return { ...input, payload, headers: { ...input.headers, 'x-sign': sign } };
  }
  return input;
}

// The api entry module is loaded by address (as the kit loads it), so the type check of this
// project does not pull in the api sources; the same address yields the same module instance, so
// the spy below catches the kit's own call.
interface BootstrapModule {
  createHttpApp(...args: unknown[]): Promise<object>;
}
const ROOT = new URL('../../../../', import.meta.url);
const bootstrap = (await import(
  new URL('apps/api/src/bootstrap.ts', ROOT).href
)) as BootstrapModule;

const originalCreateHttpApp = bootstrap.createHttpApp;
vi.spyOn(bootstrap, 'createHttpApp').mockImplementation(async (...args) => {
  const app = await originalCreateHttpApp(...args);
  const inject = (app as unknown as Injectable).inject.bind(app);
  const wrapped = async (input: InjectInput): Promise<InjectResponse> => {
    const response = await inject(rewrite(input));
    if (input.method === 'POST' && input.url === '/v1/devices' && response.statusCode === 200) {
      const device = (response.json() as { data: { device_id: string; install_secret: string } })
        .data;
      secrets.set(device.device_id, device.install_secret);
    }
    return response;
  };
  // The entry is itself a proxy that refuses writes: hand out a view whose inject is wrapped and
  // whose every other member is the entry's own, bound to it.
  return new Proxy(app, {
    get(target, property) {
      if (property === 'inject') return wrapped;
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
});

const h = authorityHarness({ createTestDatabase, acquireTestRedis });

/** A distinct obvious-demo answer per case (never a Pinduoduo payload). */
function demoAnswer(tag: string): PddAuthorityUrl {
  return {
    url: `https://demo.invalid/authority/page/${tag}`,
    mobile_short_url: `https://demo.invalid/authority/m/${tag}`,
    schema_url: `couli-demo://pdd/authority/${tag}`,
  };
}

/** D10-662 on one plan, with the scheme step asserted present (not left to a branch). */
function expectSchemePlan(plan: unknown, answer: PddAuthorityUrl): void {
  const scheme = answer.schema_url!;
  const web = answer.mobile_short_url!;
  expect(scheme.startsWith('couli-demo://')).toBe(true);
  expect(new URL(web).protocol).toBe('https:');
  const typed = plan as AuthJumpPlan;
  const steps = [typed.primary, ...typed.fallbacks];
  const schemeSteps = steps.filter((step) => step.type === 'scheme');
  expect(schemeSteps.length, JSON.stringify(steps)).toBeGreaterThan(0);
  for (const step of schemeSteps) expect(step.value).toBe(scheme);
  const h5Steps = steps.filter((step) => step.type === 'h5');
  expect(h5Steps.length, JSON.stringify(steps)).toBeGreaterThan(0);
  for (const step of h5Steps) expect(step.value).toBe(web);
  for (const step of steps.filter((each) => each.type !== 'scheme')) {
    expect(step.value).not.toContain(scheme);
    expect(step.value).not.toContain(encodeURIComponent(scheme));
    expect(step.value).not.toContain('couli-demo');
  }
  expectAuthSteps(plan, answer);
}

async function authUrlCase(value: Installed, tag: string): Promise<void> {
  installed = value;
  const t = await h.tenant();
  const u = await t.user();
  const answer = demoAnswer(tag);
  h.answerAuthorityUrl(answer);
  try {
    const response = await u.authUrl('pdd');
    const calls = h.authorityUrlCalls(t.appId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.result).toEqual(answer);
    const data = await issued(response);
    expect(data.auth_url).toBe(answer.mobile_short_url);
    expect(new URL(data.auth_url).protocol).toBe('https:');
    expect(data.auth_url).not.toContain(answer.schema_url!);
    expect(data.auth_url).not.toContain(encodeURIComponent(answer.schema_url!));
    expect(data.auth_jump, response.payload).toEqual(expect.any(Object));
    expectSchemePlan(data.auth_jump, answer);
    expectNoState([data.auth_url, ...planValues(data.auth_jump)], data.state);
  } finally {
    installed = null;
  }
}

async function openCase(value: Installed, tag: string): Promise<void> {
  installed = value;
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const answer = demoAnswer(tag);
  h.answerAuthorityUrl(answer);
  try {
    const response = await u.open(linkId);
    const calls = h.authorityUrlCalls(t.appId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.result).toEqual(answer);
    const body = await refused(response, 422, 30111);
    const plan = body.data?.['auth_jump'];
    expect(plan, response.payload).toEqual(expect.any(Object));
    expectSchemePlan(plan, answer);
    const rows = await t.sessions();
    expect(rows).toHaveLength(1);
    expectNoState(planValues(plan), rows[0]!.state);
    expect(h.convertCalls(t.appId)).toEqual([]);
  } finally {
    installed = null;
  }
}

it('[AC-B1-06zfa#1] 拼多多 auth-url，installed=true：计划里有 scheme 步且值就是上游 schema_url 原样，h5 步是 mobile_short_url，其他步不含 schema_url（原样或编码），auth_url 是 https 网页地址', async () => {
  await authUrlCase('true', 'b1-06zfa-1');
}, 60_000);

it('[AC-B1-06zfa#2] 拼多多 auth-url，installed=unknown：计划里有 scheme 步且值就是上游 schema_url 原样，h5 步是 mobile_short_url，其他步不含 schema_url（原样或编码），auth_url 是 https 网页地址', async () => {
  await authUrlCase('unknown', 'b1-06zfa-2');
}, 60_000);

it('[AC-B1-06zfa#3] 点击购买 open 未授权（30111 auth_jump），installed=true：计划里有 scheme 步且值就是上游 schema_url 原样，h5 步是 mobile_short_url，其他步不含 schema_url（原样或编码）', async () => {
  await openCase('true', 'b1-06zfa-3');
}, 60_000);

it('[AC-B1-06zfa#4] 点击购买 open 未授权（30111 auth_jump），installed=unknown：计划里有 scheme 步且值就是上游 schema_url 原样，h5 步是 mobile_short_url，其他步不含 schema_url（原样或编码）', async () => {
  await openCase('unknown', 'b1-06zfa-4');
}, 60_000);
