// Unit tests of the console's risk rule list and enable / disable (B1-03zg): the body checks that
// come before any SQL, the list view (catalog name / threshold_keys, fallback with a warn, the
// writers' legacy status), and the compare-and-set flow over a scripted pg client (no database).
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock, type AuditInput, type RootLogger } from '../../platform/index.ts';
import {
  AdminRiskRuleConflictError,
  AdminRiskRules,
  AdminRiskRulesFieldsError,
  riskRuleStatusOf,
  type AdminRiskRuleCommand,
} from './admin-risk-rules.ts';
import { riskRuleCatalogEntry } from './risk-rule-catalog.ts';

const APP = 'couli';
const ADMIN = '019a0000-0000-7000-8000-0000000000a1';
const NOW = '2031-05-06T07:08:09.000Z';
const EARLIER = new Date('2031-05-01T00:00:00.000Z');

type Row = Record<string, unknown>;
type Rows = (text: string, params: readonly unknown[]) => readonly Row[];

function ruleRow(overrides: Row = {}): Row {
  return {
    id: '019a0000-0000-7000-8000-000000000b01',
    rule_id: 'BLACKLIST_PHONE',
    scene: 'register',
    risk_action: 'block',
    status: 'enabled',
    version: 6,
    updated_at: EARLIER,
    ...overrides,
  };
}

function harness(rows: Rows = () => []) {
  const sqls: { text: string; params: readonly unknown[] }[] = [];
  const client = {
    release() {},
    async query(text: string, params: readonly unknown[] = []) {
      sqls.push({ text, params });
      const result = rows(text, params);
      return { command: 'SELECT', rowCount: result.length, rows: result };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  });
  const audits: AuditInput[] = [];
  const warns: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => void warns.push(args) } as unknown as RootLogger;
  const rules = new AdminRiskRules({
    db,
    clock: new FixedClock(NOW),
    logger,
    auditOn: () => ({ append: async (input) => void audits.push(input) }),
  });
  return { rules, sqls, audits, warns };
}

function command(overrides: Partial<AdminRiskRuleCommand> = {}): AdminRiskRuleCommand {
  return {
    appId: APP,
    adminId: ADMIN,
    ip: '203.0.113.9',
    ruleId: 'BLACKLIST_PHONE',
    change: 'disable',
    body: { expected_version: 6, reason: '误拦已排查' },
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

it.each([
  [{}, ['expected_version']],
  [{ expected_version: -1 }, ['expected_version']],
  [{ expected_version: 1.5 }, ['expected_version']],
  [{ expected_version: '6' }, ['expected_version']],
  [{ expected_version: 6, reason: '' }, ['reason']],
  [{ expected_version: 6, reason: null }, ['reason']],
  [{ expected_version: 6, reason: '因'.repeat(201) }, ['reason']],
  [{ expected_version: null, reason: 7 }, ['expected_version', 'reason']],
])('[AC-B1-03zg#23] body %j is refused with its fields before any SQL', async (body, fields) => {
  const h = harness();
  const error = await failure(
    h.rules.change(command({ body: body as AdminRiskRuleCommand['body'] })),
  );
  expect(error).toBeInstanceOf(AdminRiskRulesFieldsError);
  expect((error as AdminRiskRulesFieldsError).fields).toEqual(fields);
  expect(h.sqls).toEqual([]);
});

it('[AC-B1-03zg#17] list: scoped by app_id, ordered by scene then rule_id, no conditions selected', async () => {
  const h = harness(() => [ruleRow()]);
  const items = await h.rules.list(APP);
  expect(items).toHaveLength(1);
  const select = h.sqls[0]!;
  expect(select.text).toMatch(/from "app"\."risk_rules"/);
  expect(select.text).toMatch(/where "app_id" = \$1/);
  expect(select.text).toMatch(/order by "scene", "rule_id"/);
  expect(select.text).not.toContain('conditions');
  expect(select.params).toEqual([APP]);
});

it('[AC-B1-03zg#19] list: name and threshold_keys come from the catalog, without a warn', async () => {
  const h = harness(() => [ruleRow()]);
  const entry = riskRuleCatalogEntry('BLACKLIST_PHONE')!;
  expect(await h.rules.list(APP)).toEqual([
    {
      rule_id: 'BLACKLIST_PHONE',
      scene: 'register',
      name: entry.name,
      risk_action: 'block',
      status: 'enabled',
      threshold_keys: [...entry.thresholdKeys],
      version: 6,
      updated_at: EARLIER.toISOString(),
    },
  ]);
  expect(h.warns).toEqual([]);
});

it('[AC-B1-03zg#20] list: a code the catalog lacks falls back to rule_id and [] with one warn', async () => {
  const h = harness(() => [ruleRow({ rule_id: 'ZZ_UNKNOWN', status: 'disabled' })]);
  const [item] = await h.rules.list(APP);
  expect(item).toMatchObject({ rule_id: 'ZZ_UNKNOWN', name: 'ZZ_UNKNOWN', threshold_keys: [] });
  expect(item?.status).toBe('disabled');
  expect(h.warns).toHaveLength(1);
  expect(JSON.stringify(h.warns[0])).toContain('ZZ_UNKNOWN');
});

it('[AC-B1-03zg#18] the writers’ stored status active reads as enabled; disabled stays disabled', () => {
  expect(riskRuleStatusOf('active')).toBe('enabled');
  expect(riskRuleStatusOf('enabled')).toBe('enabled');
  expect(riskRuleStatusOf('disabled')).toBe('disabled');
});

it('[AC-B1-03zg#26] change: no row of (app_id, rule_id) → 20001 [rule_id], nothing updated', async () => {
  const h = harness(() => []);
  const error = await failure(h.rules.change(command()));
  expect(error).toBeInstanceOf(AdminRiskRulesFieldsError);
  expect((error as AdminRiskRulesFieldsError).fields).toEqual(['rule_id']);
  const lock = h.sqls.find((s) => s.text.includes('for update'))!;
  expect(lock.text).toMatch(/where "app_id" = \$1 and "rule_id" = \$2/);
  expect(lock.params).toEqual([APP, 'BLACKLIST_PHONE']);
  expect(h.sqls.some((s) => s.text.startsWith('update'))).toBe(false);
  expect(h.audits).toEqual([]);
});

it('[AC-B1-03zg#27] change: a version mismatch → 20902, nothing updated or audited', async () => {
  const h = harness((text) => (text.includes('for update') ? [ruleRow({ version: 7 })] : []));
  expect(await failure(h.rules.change(command()))).toBeInstanceOf(AdminRiskRuleConflictError);
  expect(h.sqls.some((s) => s.text.startsWith('update'))).toBe(false);
  expect(h.audits).toEqual([]);
});

it('[AC-B1-03zg#31] change: already in the target status with the version → unchanged, no update, no audit', async () => {
  const h = harness((text) =>
    text.includes('for update') ? [ruleRow({ status: 'disabled' })] : [],
  );
  const data = await h.rules.change(command());
  expect(data).toMatchObject({ status: 'disabled', version: 6 });
  expect(h.sqls.some((s) => s.text.startsWith('update'))).toBe(false);
  expect(h.audits).toEqual([]);
});

it('[AC-B1-03zg#29] change: the CAS update is scoped by app_id and expected version; one audit row', async () => {
  const now = new Date(NOW);
  const h = harness((text) => {
    if (text.includes('for update')) return [ruleRow({ status: 'active' })];
    if (text.startsWith('update')) {
      return [ruleRow({ status: 'disabled', version: 7, updated_at: now })];
    }
    return [];
  });
  const data = await h.rules.change(command());
  expect(data).toMatchObject({ status: 'disabled', version: 7, updated_at: NOW });
  const update = h.sqls.find((s) => s.text.startsWith('update'))!;
  expect(update.text).toMatch(/"version" = "version" \+ \$\d/);
  expect(update.text).toMatch(/"app_id" = \$\d+ and "rule_id" = \$\d+ and "version" = \$\d+/);
  expect(update.params).toContain(APP);
  expect(update.params).toContain('disabled');
  expect(update.params).toContainEqual(now);
  expect(h.audits).toEqual([
    {
      appId: APP,
      actor: ADMIN,
      action: 'risk_rule_disable',
      target: 'BLACKLIST_PHONE',
      before: { rule_id: 'BLACKLIST_PHONE', status: 'enabled', version: 6 },
      after: { rule_id: 'BLACKLIST_PHONE', status: 'disabled', version: 7, reason: '误拦已排查' },
      ip: '203.0.113.9',
    },
  ]);
});

it('[AC-B1-03zg#33] change: the CAS update matching no row (version moved) → 20902, no audit', async () => {
  const h = harness((text) =>
    text.includes('for update') ? [ruleRow({ status: 'enabled' })] : [],
  );
  expect(await failure(h.rules.change(command()))).toBeInstanceOf(AdminRiskRuleConflictError);
  expect(h.audits).toEqual([]);
});
