// B1-03zg rule-test kit: the console's risk rule list and enable / disable (CT-24f
// adminListRiskRules, adminEnableRiskRule, adminDisableRiskRule; BR-ID-36 细则「规则清单的启停」).
// Real admin entry, admin sessions, totp step-up and database; no replacement routes. Rules are
// seeded straight into app.risk_rules with status enabled / disabled (04 §3.2); their conditions
// carry a marker that must never be returned. name / threshold_keys are compared with risk's own
// catalog (risk-rule-catalog.ts), whose content catalog.test.ts checks on its own. Every execution
// belongs to the isolated container runner.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  NOW,
  account,
  apiRequire,
  fixture,
  signedIn,
  totp,
  type Account,
  type Fixture,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { ok, STEP, type Grant } from '../../admin/step-up/kit.ts';
import { riskRuleCatalogEntry } from '../../../../apps/api/src/modules/risk/application/risk-rule-catalog.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const LIST = '/admin/v1/risk-rules';
export const ENABLE = '/admin/v1/risk-rules/{rule_id}/enable';
export const DISABLE = '/admin/v1/risk-rules/{rule_id}/disable';
export const PERMISSION = 'config.risk';
export const DENIED = { reason: 'admin_permission_denied' };
export const TOTP_REQUIRED = { tier: 'totp' };
export const CONFLICT = { resource: 'risk_rule' };
export const RULE_ID_INVALID = { fields: ['rule_id'] };
export const VERSION_INVALID = { fields: ['expected_version'] };
export const REASON_INVALID = { fields: ['reason'] };
export const CONDITION_MARKER = 'cond-marker-';
export const FIELDS = [
  'name',
  'risk_action',
  'rule_id',
  'scene',
  'status',
  'threshold_keys',
  'updated_at',
  'version',
] as const;
export const CHANGES = ['enable', 'disable'] as const;
export const HOUR = 3_600_000;

export type Change = (typeof CHANGES)[number];
export type Status = 'enabled' | 'disabled';
export type Rule = Schema<'AdminRiskRule'>;
export type RuleRow = Selectable<DB['risk_rules']>;
export type AuditRow = Selectable<DB['audit_logs']>;

/** The status a change leads to, and the one it starts from when it is a change. */
export const targetOf = (change: Change): Status => (change === 'enable' ? 'enabled' : 'disabled');
export const otherOf = (change: Change): Status => (change === 'enable' ? 'disabled' : 'enabled');
/** One instant as an ISO string, whatever offset the server wrote it with. */
export const iso = (value: string | Date) => new Date(value).toISOString();
/** The fixture clock's start plus an offset. */
export const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs);
/** A rule code no catalog would hold (^[A-Za-z][A-Za-z0-9_]*$). */
export const unlistedId = () => `ZZ_UNLISTED_${randomUUID().replaceAll('-', '').toUpperCase()}`;

/** The three routes, as registered on an entry. */
export function mounted(f: Fixture): boolean[] {
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(options: { method: 'GET' | 'POST'; url: string }): boolean;
  };
  return [
    server.hasRoute({ method: 'GET', url: LIST }),
    server.hasRoute({ method: 'POST', url: `${LIST}/:rule_id/enable` }),
    server.hasRoute({ method: 'POST', url: `${LIST}/:rule_id/disable` }),
  ];
}

/** An admin account of `appId` whose TOTP secret is sealed under that app's context. */
async function admin(h: Harness, appId: string, isSuper: boolean): Promise<Account> {
  const a = await account(h, { app_id: appId, is_super: isSuper });
  await h.db
    .updateTable('admin_users')
    .set({
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(a.secret, `admin_users.totp_secret:${appId}:${a.id}`),
      ),
    })
    .where('id', '=', a.id)
    .execute();
  return a;
}

export async function grant(
  s: { readonly h: Harness; readonly f: Fixture; readonly a: Account; readonly appId: string },
  keys: readonly string[],
) {
  for (const key of keys) {
    await s.h.db
      .insertInto('admin_permissions')
      .values({
        app_id: s.appId,
        admin_id: s.a.id,
        permission_key: key,
        granted_by: s.a.id,
        granted_at: s.f.clock.now(),
      })
      .execute();
  }
}

export interface ChangeOptions {
  /** undefined: a fresh totp step-up token; null: no X-Step-Up-Token header. */
  readonly token?: string | null;
  readonly headers?: Record<string, string>;
}

export async function setup(
  h: Harness,
  options: { grants?: readonly string[]; isSuper?: boolean } = {},
) {
  const appId = `rules_${randomUUID().replaceAll('-', '')}`;
  const f = await fixture(h);
  expect(
    mounted(f),
    'GET /admin/v1/risk-rules and POST /admin/v1/risk-rules/{rule_id}/enable|disable on the admin entry',
  ).toEqual([true, true, true]);
  const a = await admin(h, appId, options.isSuper ?? false);
  const session = await signedIn(f, a);
  const auth = { authorization: `Bearer ${session.admin_token}` };
  // A fresh totp-tier step-up token of this session (each in a new 30-second TOTP window).
  const issue = async () => {
    f.clock.advanceMs(30_000);
    const granted = await ok<Grant>(
      await f.post('/step-up', { tier: 'totp', code: totp(a.secret, f.clock) }, auth),
      STEP,
    );
    return granted.step_up_token;
  };
  const list = (headers: Record<string, string> = {}) => f.read(session.admin_token, LIST, headers);
  const change = async (
    which: Change,
    ruleId: string,
    body: Record<string, unknown>,
    opts: ChangeOptions = {},
  ) => {
    const token = opts.token === undefined ? await issue() : opts.token;
    return f.app.inject({
      method: 'POST',
      url: `${LIST}/${encodeURIComponent(ruleId)}/${which}`,
      headers: {
        'content-type': 'application/json',
        ...auth,
        ...(token === null ? {} : { 'x-step-up-token': token }),
        ...opts.headers,
      },
      payload: JSON.stringify(body),
    });
  };
  const s = { h, f, a, appId, token: session.admin_token, issue, list, change };
  await grant(s, options.grants ?? [PERMISSION]);
  return s;
}
export type Scenario = Awaited<ReturnType<typeof setup>>;

export interface Seed {
  readonly rule_id: string;
  readonly scene?: string;
  readonly status?: Status;
  readonly version?: number;
  readonly risk_action?: Rule['risk_action'];
  readonly updated_at?: Date;
}

/** One risk_rules row of `appId` (default: the scenario's app). */
export async function seedRule(s: Scenario, seed: Seed, appId = s.appId): Promise<RuleRow> {
  return s.h.db
    .insertInto('risk_rules')
    .values({
      id: randomUUID(),
      app_id: appId,
      rule_id: seed.rule_id,
      scene: seed.scene ?? 'register',
      conditions: JSON.stringify({ limit_note: `${CONDITION_MARKER}${seed.rule_id}` }),
      risk_action: seed.risk_action ?? 'block',
      status: seed.status ?? 'enabled',
      version: seed.version ?? 1,
      created_at: at(-30 * 24 * HOUR),
      updated_at: seed.updated_at ?? at(-2 * HOUR),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function ruleRow(s: Scenario, ruleId: string, appId = s.appId): Promise<RuleRow> {
  return s.h.db
    .selectFrom('risk_rules')
    .selectAll()
    .where('app_id', '=', appId)
    .where('rule_id', '=', ruleId)
    .executeTakeFirstOrThrow();
}

/** The app's rule rows, by rule_id. */
export function ruleRows(s: Scenario, appId = s.appId): Promise<RuleRow[]> {
  return s.h.db
    .selectFrom('risk_rules')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('rule_id')
    .execute();
}

/** The app's risk rule audit records (sign-in and step-up records are not counted). */
export function ruleAudits(s: Scenario, appId = s.appId): Promise<AuditRow[]> {
  return s.h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('action', 'in', ['risk_rule_enable', 'risk_rule_disable'])
    .orderBy('id')
    .execute();
}

/** Everything a refused or unchanged call must leave as it was. */
export async function snapshot(s: Scenario, appId = s.appId) {
  return { rules: await ruleRows(s, appId), audits: await ruleAudits(s, appId) };
}

/** name / threshold_keys as risk's catalog gives them, with the fallback for an unlisted code. */
export function display(ruleId: string): Pick<Rule, 'name' | 'threshold_keys'> {
  const entry = riskRuleCatalogEntry(ruleId);
  return entry === null
    ? { name: ruleId, threshold_keys: [] }
    : { name: entry.name, threshold_keys: [...entry.thresholdKeys] };
}

/** The list row a risk_rules row must produce (updated_at as an ISO instant). */
export function expectedRule(row: RuleRow): Rule {
  return {
    rule_id: row.rule_id,
    scene: row.scene,
    ...display(row.rule_id),
    risk_action: row.risk_action as Rule['risk_action'],
    status: row.status as Rule['status'],
    version: row.version,
    updated_at: row.updated_at.toISOString(),
  };
}

/** A response row with its instant rewritten as an ISO string (offsets differ, instants not). */
export const instant = (rule: Rule): Rule => ({ ...rule, updated_at: iso(rule.updated_at) });

/** The row columns a change may not touch, plus the three it may (row_version left out). */
export function columns(row: RuleRow) {
  return {
    id: row.id,
    app_id: row.app_id,
    rule_id: row.rule_id,
    scene: row.scene,
    conditions: row.conditions,
    risk_action: row.risk_action,
    created_at: row.created_at,
    status: row.status,
    version: row.version,
    updated_at: row.updated_at,
  };
}

// ---- contract checks ----

interface Operation {
  operationId: string;
  'x-auth'?: string;
  'x-implementation'?: string;
}
interface Document {
  paths: Record<string, { get?: Operation; post?: Operation }>;
  components: { schemas: Record<string, JsonSchema> };
}
let document: Promise<Document> | undefined;
export function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}
export async function validate(response: Response, name: string) {
  const check = createValidatorCompiler()({
    schema: (await contract()).components.schemas[name]!,
    httpPart: 'body',
  });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}

export async function listed(response: Response): Promise<Rule[]> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, 'AdminRiskRuleListResponse');
  return response.json<{ data: { items: Rule[] } }>().data.items;
}
export async function accepted(response: Response): Promise<Rule> {
  expect(response.statusCode).toBe(200);
  expect(response.json().code).toBe(0);
  await validate(response, 'AdminRiskRuleResponse');
  return response.json<{ data: Rule }>().data;
}
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode).toBe(
    code === 20001 ? 400 : code === 20902 ? 409 : code === 10001 ? 401 : 403,
  );
  expect(response.json().code).toBe(code);
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, 'ErrorEnvelope');
}

/** The warn lines (pino level 40) of the entry's logger that mention `text`. */
export function warnsAbout(f: Fixture, text: string): unknown[] {
  return f.lines
    .map((line) => JSON.parse(line) as { level?: unknown })
    .filter((line) => line.level === 40 && JSON.stringify(line).includes(text));
}
