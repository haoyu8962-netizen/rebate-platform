// B1-03zg: GET /admin/v1/risk-rules (CT-24f adminListRiskRules): every risk_rules row of the
// console's app, by scene, then rule_id; not paged, not filtered; exactly the eight AdminRiskRule
// fields (never the conditions JSON); name / threshold_keys from risk's catalog, falling back to
// rule_id and [] with a warn when the catalog lacks the code (orchestrator ruling #2078).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { riskRuleCatalog } from '../../../../apps/api/src/modules/risk/application/risk-rule-catalog.ts';
import {
  CONDITION_MARKER,
  FIELDS,
  HOUR,
  at,
  expectedRule,
  instant,
  listed,
  seedRule,
  setup,
  snapshot,
  unlistedId,
  warnsAbout,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-03zg#17] 只列本 app 的全部规则，按 scene 再 rule_id 排序，不分页', async () => {
  const s = await setup(h);
  const other = await setup(h);
  // Inserted out of order; scenes are lower-case letters and codes upper-case letters only, so
  // the order is the same under any collation.
  const seeds = [
    { rule_id: 'QA', scene: 'withdrawal' },
    { rule_id: 'QD', scene: 'login' },
    { rule_id: 'QE', scene: 'register' },
    { rule_id: 'QB', scene: 'register' },
    { rule_id: 'QC', scene: 'login' },
    { rule_id: 'QF', scene: 'invite' },
  ];
  for (const [i, seed] of seeds.entries()) {
    await seedRule(s, { ...seed, version: i, status: i % 2 === 0 ? 'enabled' : 'disabled' });
    await seedRule(other, { rule_id: `${seed.rule_id}OTHERAPP`, scene: 'aaa' });
  }
  for (let i = 0; i < 25; i += 1) {
    await seedRule(s, { rule_id: `QZ${String.fromCharCode(65 + i)}`, scene: 'zzz' });
  }
  const items = await listed(await s.list());
  expect(items.slice(0, 6).map((item) => [item.scene, item.rule_id])).toEqual([
    ['invite', 'QF'],
    ['login', 'QC'],
    ['login', 'QD'],
    ['register', 'QB'],
    ['register', 'QE'],
    ['withdrawal', 'QA'],
  ]);
  expect(items).toHaveLength(31);
  expect(items.slice(6).map((item) => item.rule_id)).toEqual(
    Array.from({ length: 25 }, (_, i) => `QZ${String.fromCharCode(65 + i)}`),
  );
  expect(items.some((item) => item.rule_id.endsWith('OTHERAPP'))).toBe(false);
});

it('[AC-B1-03zg#18] 每行恰为契约八项，取值与库中一致，不返回条件 JSON', async () => {
  const s = await setup(h);
  const rows = [
    await seedRule(s, {
      rule_id: unlistedId(),
      scene: 'register',
      status: 'enabled',
      version: 0,
      risk_action: 'block',
      updated_at: at(-5 * HOUR),
    }),
    await seedRule(s, {
      rule_id: unlistedId(),
      scene: 'withdraw',
      status: 'disabled',
      version: 7,
      risk_action: 'manual_review',
      updated_at: at(-HOUR),
    }),
    await seedRule(s, {
      rule_id: unlistedId(),
      scene: 'order',
      status: 'enabled',
      version: 2,
      risk_action: 'void_commission',
    }),
    await seedRule(s, {
      rule_id: unlistedId(),
      scene: 'share',
      status: 'disabled',
      version: 3,
      risk_action: 'pass',
    }),
  ];
  const response = await s.list();
  const items = await listed(response);
  for (const item of items) expect(Object.keys(item).sort()).toEqual([...FIELDS]);
  const byId = new Map(items.map((item) => [item.rule_id, instant(item)]));
  for (const row of rows) expect(byId.get(row.rule_id), row.rule_id).toEqual(expectedRule(row));
  const body = JSON.stringify(response.json());
  expect(body).not.toContain(CONDITION_MARKER);
  expect(body).not.toMatch(/"(?:conditions|id|app_id|row_version|created_at)"\s*:/);
});

it('[AC-B1-03zg#19] name 与 threshold_keys 取自风控规则目录', async () => {
  const s = await setup(h);
  const catalogued = riskRuleCatalog().slice(0, 4);
  expect(catalogued.length).toBeGreaterThan(0);
  for (const entry of catalogued) await seedRule(s, { rule_id: entry.ruleId, scene: 'register' });
  const items = await listed(await s.list());
  for (const entry of catalogued) {
    const item = items.find((i) => i.rule_id === entry.ruleId);
    expect(item, entry.ruleId).toMatchObject({
      rule_id: entry.ruleId,
      name: entry.name,
      threshold_keys: [...entry.thresholdKeys],
    });
    expect(warnsAbout(s.f, entry.ruleId), entry.ruleId).toEqual([]);
  }
});

it('[AC-B1-03zg#20] 目录缺项的规则照常列出：name 回落 rule_id、threshold_keys 回落 []，并记 warn', async () => {
  const s = await setup(h);
  const ruleId = unlistedId();
  expect(riskRuleCatalog().some((entry) => entry.ruleId === ruleId)).toBe(false);
  await seedRule(s, { rule_id: ruleId, scene: 'register', status: 'disabled', version: 3 });
  const items = await listed(await s.list());
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    rule_id: ruleId,
    name: ruleId,
    threshold_keys: [],
    status: 'disabled',
    version: 3,
  });
  expect(warnsAbout(s.f, ruleId).length).toBeGreaterThan(0);
});

it('[AC-B1-03zg#21] 没有规则时返回空列表', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await seedRule(other, { rule_id: unlistedId() });
  expect(await listed(await s.list())).toEqual([]);
});

it('[AC-B1-03zg#22] 查看列表只读：不改规则、不写审计', async () => {
  const s = await setup(h);
  await seedRule(s, { rule_id: unlistedId(), status: 'enabled', version: 1 });
  await seedRule(s, { rule_id: unlistedId(), status: 'disabled', version: 9 });
  const before = await snapshot(s);
  await listed(await s.list());
  await listed(await s.list());
  expect(await snapshot(s)).toEqual(before);
  const all = await h.db
    .selectFrom('audit_logs')
    .select('action')
    .where('app_id', '=', s.appId)
    .where('action', 'like', 'risk_rule%')
    .execute();
  expect(all).toEqual([]);
});
