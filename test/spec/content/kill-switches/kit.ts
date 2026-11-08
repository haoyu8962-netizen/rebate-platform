// F1-10d rule-test kit: the emergency switch admin routes of the content module.
//   GET /admin/v1/kill-switches        (adminListKillSwitches)
//   PUT /admin/v1/kill-switches/{key}  (adminUpdateKillSwitch)
// and the pure helpers in apps/api/src/modules/content/domain/kill-switch.ts.
//
// Sources (SPEC_REF): contracts/openapi.yaml (CT-02i, the only source of shapes and codes);
// 规划/04 §10.2 / §11.2; BR-WDR-17, BR-WDR-30, BR-INV-21; orchestrator rulings in task brief
// §9.2 #1–#7 (couli-runs/F1-10a/decision-orchestrator.md 1–12). The registry oracle is the
// frozen F1-10b kit (test/spec/content/switch-read/kit.ts), never the implementation's registry.
// Readings fixed here so the implementation does not have to guess:
//   - List rows: every literal key of the registry once; a key pattern lists at least every
//     concrete key of that pattern that has a config_items row of the caller's app (other
//     concrete keys of a pattern may be listed too, with value null and version 0). No key that
//     is not a registered switch is ever listed. Rows are grouped in registry order.
//   - `default` of a concrete pattern key is the pattern's per-placeholder override when there is
//     one (payout.channel_enabled.alipay → true), else the pattern default.
//   - The list reads config_items on the primary handle at request time (no cache).
//   - A successful change returns the switch as it is now: version + 1, the admin's login name as
//     updated_by and the injected Clock as updated_at.
//   - History: exactly one new app.config_item_versions row per change: version = new version,
//     value = new value, updated_by = login name, updated_by_admin_id = admin id, reason (null when
//     the request has none), created_at = Clock.
//   - Audit: exactly one new audit_logs row, action `kill_switch_change`, admin_id = admin id,
//     at = Clock; its before and after objects together carry key, from_version, to_version and
//     reason; `before.value` is the stored value before the change and `after.value` the new one.
//   - Alert: exactly one pino line at warn (40) with msg `config_change_alert` per change, none for
//     a refused change; its fields carry `key`, the old value under a field named from / before /
//     from_value / before_value, the new value under to / after / to_value / after_value, the
//     request's trace id and the admin (id or login name); no other configuration value.
//   - Ordering of checks that both fail (e.g. a bad value from an account without the point) is
//     not fixed; the tests never combine two failures.
//   - Same-value writes (orchestrator ruling 13, as the contract): a value equal to the stored one
//     with a matching expected_version is a no-op: 200 with the switch as it is, version, row,
//     history, audit unchanged and no alert; the point and the step-up token are still required
//     (whether the token is consumed is not asserted). A switch never written (no row, version 0,
//     value null) has no stored value: its first write is a change (version 1) even when the
//     value equals the registered default. No other test writes a stored value again.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { grant, seed, type Seed } from '../../admin/accounts/kit.ts';
import {
  apiRequire,
  fixture,
  signedIn,
  totp,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import { ok, STEP, type Grant } from '../../admin/step-up/kit.ts';

export * from './oracle.ts';

export const LIST = '/admin/v1/kill-switches';
export const ITEM = `${LIST}/{key}`;
export const POINTS = ['switch.all', 'switch.payout', 'switch.pay'] as const;
export type Point = (typeof POINTS)[number];
export const ACTION = 'kill_switch_change';
export const ALERT = 'config_change_alert';
export const DENIED = { reason: 'admin_permission_denied' };
export const SEEDED_AT = '2026-10-05T01:02:03.000Z';
export type Json = DB['config_items']['value'];
export type Row = Schema<'AdminKillSwitch'>;
export type Page = Schema<'AdminKillSwitchPage'>;

// ---------------------------------------------------------------------------------------------
// Fixture.

export async function setup(h: Harness) {
  const f = await fixture(h);
  const appId = `f1-10d-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  // Missing business routes must fail every test, negative ones included: never a false green
  // from a 404 or a global hook. No test-only route registration.
  expect(hasRoute(f.app, 'GET', LIST), LIST).toBe(true);
  expect(hasRoute(f.app, 'PUT', ITEM), ITEM).toBe(true);
  return { ...f, actor, appId, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export interface Caller {
  readonly account: Seed;
  readonly token: string;
}

/** The fixture's super admin as a caller. */
export const owner = (f: Setup): Caller => ({ account: f.actor, token: f.token });

/** A non-super admin of the fixture's app holding exactly `points`, signed in. */
export async function member(h: Harness, f: Setup, points: readonly string[]): Promise<Caller> {
  const account = await seed(h, f.appId);
  if (points.length > 0) await grant(h, account, f.actor, points);
  const session = await signedIn(f, account);
  return { account, token: session.admin_token };
}

/** A fresh totp-tier step-up token of `caller` (the clock moves one TOTP step first). */
export async function stepUp(f: Setup, caller: Caller): Promise<string> {
  f.clock.advanceMs(30_000);
  // The previous (already consumed) step is still in the verifier's [-1,+1] window and the
  // verifier keeps the earliest match, so skip steps whose code equals the previous one.
  while (totp(caller.account.secret, f.clock, -1) === totp(caller.account.secret, f.clock))
    f.clock.advanceMs(30_000);
  const grantData = await ok<Grant>(
    await f.post(
      '/step-up',
      { tier: 'totp', code: totp(caller.account.secret, f.clock) },
      { authorization: `Bearer ${caller.token}` },
    ),
    STEP,
  );
  expect(grantData.step_up_token).toEqual(expect.any(String));
  return grantData.step_up_token;
}

export function hasRoute(app: HttpApp, method: 'GET' | 'PUT', path: string): boolean {
  const server = app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  return server.hasRoute({ method, url: path.replace(/\{(\w+)\}/g, ':$1') });
}

interface AnyApp {
  inject(input: {
    method: 'GET' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
}

export interface Sent {
  readonly response: Response;
  readonly trace: string;
}

export async function listPage(
  app: HttpApp,
  token: string | null,
  query = '',
  extra: Record<string, string> = {},
): Promise<Sent> {
  const trace = randomUUID();
  const response = await (app as unknown as AnyApp).inject({
    method: 'GET',
    url: `${LIST}${query}`,
    headers: {
      'x-trace-id': trace,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    },
    remoteAddress: '127.0.0.1',
  });
  return { response, trace };
}

export async function put(
  app: HttpApp,
  caller: { readonly token: string | null },
  key: string,
  body: Record<string, unknown>,
  stepUpToken: string | null,
  trace: string = randomUUID(),
): Promise<Sent> {
  const response = await (app as unknown as AnyApp).inject({
    method: 'PUT',
    url: `${LIST}/${encodeURIComponent(key)}`,
    headers: {
      'content-type': 'application/json',
      'x-trace-id': trace,
      ...(caller.token === null ? {} : { authorization: `Bearer ${caller.token}` }),
      ...(stepUpToken === null ? {} : { 'x-step-up-token': stepUpToken }),
    },
    payload: JSON.stringify(body),
    remoteAddress: '127.0.0.1',
  });
  return { response, trace };
}

// ---------------------------------------------------------------------------------------------
// Contract checks.

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
type Operation = 'list' | 'update';
let validators: Promise<Map<string, Validator>> | undefined;
async function responseValidators() {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          Record<
            string,
            { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> }
          >
        >;
      }>;
    };
    const doc = await parser.dereference(
      fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const [op, path, method] of [
      ['list', LIST, 'get'],
      ['update', ITEM, 'put'],
    ] as const) {
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${op}:${status}`,
          compile({
            schema:
              doc.paths[path]![method]!.responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}

export async function validate(response: Response, op: Operation) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${op}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

export async function success<T>(sent: Sent, op: Operation): Promise<T> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(200);
  expect(sent.response.json()).toMatchObject({ code: 0, trace_id: sent.trace });
  await validate(sent.response, op);
  return sent.response.json<{ data: T }>().data;
}

export const updated = (sent: Sent) => success<Row>(sent, 'update');

export async function rejected(sent: Sent, op: Operation, code: number, data?: object) {
  const status =
    code === 10001
      ? 401
      : code === 10003 || code === 10403
        ? 403
        : code === 20902
          ? 409
          : code >= 50000
            ? 500
            : 400;
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(status);
  expect(sent.response.json()).toMatchObject({ code, trace_id: sent.trace });
  if (data !== undefined) expect(sent.response.json().data).toEqual(data);
  await validate(sent.response, op);
}

export const conflict = (sent: Sent) =>
  rejected(sent, 'update', 20902, { resource: 'kill_switch' });

/** Every row of the caller's list, page by page at the maximum size. */
export async function listAll(f: Pick<Setup, 'app'>, token: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const data = await success<Page>(
      await listPage(f.app, token, `?page=${page}&page_size=200`),
      'list',
    );
    expect(data).toMatchObject({ page, page_size: 200 });
    rows.push(...data.items);
    if (rows.length >= data.total || data.items.length === 0) {
      expect(rows).toHaveLength(data.total);
      return rows;
    }
  }
  throw new Error('kit: list did not end within 50 pages');
}

export const instant = (value: string | Date | null) =>
  value === null ? null : new Date(value).toISOString();

// ---------------------------------------------------------------------------------------------
// Database fixtures and snapshots (couli_app; the container runner only).

export async function seedSwitch(
  h: Harness,
  appId: string,
  key: string,
  value: Json,
  version: number,
  updatedAt = SEEDED_AT,
) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      version,
      row_version: 7,
      updated_by: 'f1-10d-seed',
      created_at: SEEDED_AT,
      updated_at: updatedAt,
    })
    .execute();
}

export async function seedHistory(
  h: Harness,
  appId: string,
  key: string,
  version: number,
  value: Json,
) {
  await h.db
    .insertInto('config_item_versions')
    .values({
      app_id: appId,
      key,
      version,
      value: sql`${JSON.stringify(value)}::jsonb`,
      updated_by: 'f1-10d-history-seed',
      updated_by_admin_id: null,
      reason: null,
      created_at: SEEDED_AT,
    })
    .execute();
}

export async function snapshot(h: Harness, appId: string) {
  return {
    items: await h.db
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .execute(),
    versions: await h.db
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .orderBy('version')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

export const item = (h: Harness, appId: string, key: string) =>
  h.db
    .selectFrom('config_items')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirst();

export const historyOf = (h: Harness, appId: string, key: string) =>
  h.db
    .selectFrom('config_item_versions')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .orderBy('version')
    .execute();

/** The one kill_switch_change audit row added since `before`; checks actor, app and time. */
export async function auditAdded(
  h: Harness,
  f: Setup,
  before: Snapshot,
  actor: Seed,
  at: Date,
): Promise<Snapshot['audits'][number]> {
  const after = await snapshot(h, f.appId);
  const ids = new Set(before.audits.map((row) => row.id));
  const added = after.audits.filter((row) => !ids.has(row.id) && row.action === ACTION);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ app_id: f.appId, admin_id: actor.id, action: ACTION });
  expect(added[0]!.at.toISOString()).toBe(at.toISOString());
  return added[0]!;
}

/** Checks the audit facts of one change (kit header). */
export function expectAuditFacts(
  audit: Snapshot['audits'][number],
  facts: {
    key: string;
    from: number;
    to: number;
    before?: Json | null;
    after: Json;
    reason: string | null;
  },
) {
  const before = (audit.before ?? {}) as Record<string, unknown>;
  const after = (audit.after ?? {}) as Record<string, unknown>;
  const merged = { ...before, ...after };
  expect(merged).toMatchObject({ key: facts.key, from_version: facts.from, to_version: facts.to });
  if (facts.reason !== null) expect(merged).toMatchObject({ reason: facts.reason });
  else expect(merged.reason ?? null).toBeNull();
  if (facts.before !== undefined) expect(before.value).toEqual(facts.before);
  expect(after.value).toEqual(facts.after);
}

// ---------------------------------------------------------------------------------------------
// Alert lines (pino JSON lines of the fixture's memory logger).

type Line = Record<string, unknown>;

export function alertLines(lines: readonly string[], from = 0): Line[] {
  return lines
    .slice(from)
    .map((line) => JSON.parse(line) as Line)
    .filter((line) => line.msg === ALERT);
}

const FROM_FIELDS = ['from', 'before', 'from_value', 'before_value'];
const TO_FIELDS = ['to', 'after', 'to_value', 'after_value'];

export function expectAlert(
  line: Line,
  facts: { key: string; from: Json | null; to: Json; trace: string; actor: Seed },
) {
  expect(line).toMatchObject({ level: 40, msg: ALERT, key: facts.key });
  const fromField = FROM_FIELDS.find((name) => Object.hasOwn(line, name));
  const toField = TO_FIELDS.find((name) => Object.hasOwn(line, name));
  expect(fromField, `old value under one of ${FROM_FIELDS.join('/')}`).toBeDefined();
  expect(toField, `new value under one of ${TO_FIELDS.join('/')}`).toBeDefined();
  expect(line[fromField!]).toEqual(facts.from);
  expect(line[toField!]).toEqual(facts.to);
  const text = JSON.stringify(line);
  expect(text, 'trace id').toContain(facts.trace);
  expect(
    text.includes(facts.actor.id) || text.includes(facts.actor.username),
    'admin id or login name',
  ).toBe(true);
}
