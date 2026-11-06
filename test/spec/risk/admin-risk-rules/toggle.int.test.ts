// B1-03zg: POST /admin/v1/risk-rules/{rule_id}/enable and …/disable (CT-24f; BR-ID-36 细则
// 「规则清单的启停」). expected_version is required and reason optional (1–200 characters), else
// 20001 naming the field; an unknown rule_id or one of another app is 20001 [rule_id]; a version
// mismatch is 20902 resource=risk_rule and changes nothing; a change sets the target status, adds
// 1 to version and writes one audit record (risk_rule_enable / risk_rule_disable, before and after
// status, reason); a rule already in the target status with a matching version succeeds
// unchanged: version stays, nothing is audited. The response is the rule as the list shows it.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CHANGES,
  CONDITION_MARKER,
  CONFLICT,
  REASON_INVALID,
  RULE_ID_INVALID,
  VERSION_INVALID,
  accepted,
  columns,
  expectedRule,
  instant,
  listed,
  otherOf,
  rejected,
  ruleAudits,
  ruleRow,
  seedRule,
  setup,
  snapshot,
  targetOf,
  unlistedId,
  type Change,
  type Scenario,
} from './kit.ts';

const h = useHarness();
const REASON = '误拦已排查，调整规则状态';

/** A rule of the scenario's app that `change` would change (it starts in the other status). */
async function changeable(s: Scenario, change: Change, version = 6) {
  return seedRule(s, {
    rule_id: unlistedId(),
    scene: 'register',
    status: otherOf(change),
    version,
  });
}

for (const change of CHANGES) {
  it.each([undefined, null, -1, 1.5, '6'])(
    `[AC-B1-03zg#23] ${change} expected_version 必填且为非负整数：%s → 20001`,
    async (expected_version) => {
      const s = await setup(h);
      const row = await changeable(s, change);
      const before = await snapshot(s);
      await rejected(
        await s.change(change, row.rule_id, { expected_version, reason: REASON }),
        20001,
        VERSION_INVALID,
      );
      expect(await snapshot(s)).toEqual(before);
    },
  );

  it.each([null, '', '因'.repeat(201), 7])(
    `[AC-B1-03zg#24] ${change} reason 选填，给了须 1–200 字：%s → 20001`,
    async (reason) => {
      const s = await setup(h);
      const row = await changeable(s, change);
      const before = await snapshot(s);
      await rejected(
        await s.change(change, row.rule_id, { expected_version: row.version, reason }),
        20001,
        REASON_INVALID,
      );
      expect(await snapshot(s)).toEqual(before);
    },
  );

  it.each([undefined, '因', '因'.repeat(200)])(
    `[AC-B1-03zg#25] ${change} reason 边界 %s 可以启停`,
    async (reason) => {
      const s = await setup(h);
      const row = await changeable(s, change);
      const body = reason === undefined ? { expected_version: 6 } : { expected_version: 6, reason };
      const data = await accepted(await s.change(change, row.rule_id, body));
      expect(data).toMatchObject({ rule_id: row.rule_id, status: targetOf(change), version: 7 });
      const audits = await ruleAudits(s);
      expect(audits).toHaveLength(1);
      // Only the text fields of the record: its id is a bigint, which JSON.stringify refuses.
      const audit = audits[0]!;
      const text = JSON.stringify([audit.target, audit.before, audit.after]);
      if (reason !== undefined) expect(text).toContain(reason);
    },
  );

  it(`[AC-B1-03zg#26] ${change} 未知规则或别的 app 的规则 → 20001 [rule_id]，身份头不能换应用`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    const theirs = await changeable(other, change);
    await changeable(s, change);
    const mine = await snapshot(s);
    const before = await snapshot(other);
    for (const ruleId of ['NO_SUCH_RULE', theirs.rule_id]) {
      await rejected(
        await s.change(
          change,
          ruleId,
          { expected_version: theirs.version },
          { headers: { 'x-app-id': other.appId, 'x-admin-id': other.a.id, 'x-is-super': 'true' } },
        ),
        20001,
        RULE_ID_INVALID,
      );
    }
    expect(await snapshot(other)).toEqual(before);
    expect(await snapshot(s)).toEqual(mine);
  });

  it.each([5, 7, 0])(
    `[AC-B1-03zg#27] ${change} 版本不符（当前 6，给 %s）→ 20902 resource=risk_rule，不改不审计`,
    async (expected_version) => {
      const s = await setup(h);
      const row = await changeable(s, change);
      const before = await snapshot(s);
      await rejected(
        await s.change(change, row.rule_id, { expected_version, reason: REASON }),
        20902,
        CONFLICT,
      );
      expect(await snapshot(s)).toEqual(before);
    },
  );

  it(`[AC-B1-03zg#28] ${change} 已是目标状态但版本不符 → 20902，不改`, async () => {
    const s = await setup(h);
    const row = await seedRule(s, { rule_id: unlistedId(), status: targetOf(change), version: 6 });
    const before = await snapshot(s);
    await rejected(await s.change(change, row.rule_id, { expected_version: 5 }), 20902, CONFLICT);
    expect(await snapshot(s)).toEqual(before);
    expect(await ruleRow(s, row.rule_id)).toEqual(row);
  });

  it(`[AC-B1-03zg#29] ${change} 生效：状态改为目标、version + 1、updated_at 取注入时钟，其他列不变`, async () => {
    const s = await setup(h);
    const row = await changeable(s, change);
    const data = await accepted(
      await s.change(change, row.rule_id, { expected_version: 6, reason: REASON }),
    );
    const now = s.f.clock.now();
    const after = await ruleRow(s, row.rule_id);
    expect(columns(after)).toEqual({
      ...columns(row),
      status: targetOf(change),
      version: 7,
      updated_at: now,
    });
    expect(instant(data)).toEqual(expectedRule(after));
    // The response is the rule's row as the list shows it now.
    const items = (await listed(await s.list())).map(instant);
    expect(items).toEqual([instant(data)]);
  });

  it(`[AC-B1-03zg#30] ${change} 生效写一条审计：动作、操作人、前后状态、原因`, async () => {
    const s = await setup(h);
    const row = await changeable(s, change);
    await accepted(await s.change(change, row.rule_id, { expected_version: 6, reason: REASON }));
    const audits = await ruleAudits(s);
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit).toMatchObject({
      app_id: s.appId,
      admin_id: s.a.id,
      action: `risk_rule_${change}`,
    });
    expect(audit.before).toMatchObject({ status: otherOf(change) });
    expect(audit.after).toMatchObject({ status: targetOf(change) });
    const text = JSON.stringify([audit.target, audit.before, audit.after]);
    expect(text).toContain(row.rule_id);
    expect(text).toContain(REASON);
    expect(text).not.toContain(CONDITION_MARKER);
  });

  it(`[AC-B1-03zg#31] ${change} 已是目标状态且版本匹配：原样成功，version 不变、不写审计`, async () => {
    const s = await setup(h);
    const row = await seedRule(s, { rule_id: unlistedId(), status: targetOf(change), version: 6 });
    const before = await snapshot(s);
    s.f.clock.advanceMs(60_000);
    const data = await accepted(
      await s.change(change, row.rule_id, { expected_version: 6, reason: REASON }),
    );
    expect(instant(data)).toEqual(expectedRule(row));
    expect(await snapshot(s)).toEqual(before);
    expect(await ruleAudits(s)).toEqual([]);
  });
}

it('[AC-B1-03zg#32] 连续启停各算一次修改：version 逐次 + 1，每次一条审计', async () => {
  const s = await setup(h);
  const row = await seedRule(s, { rule_id: unlistedId(), status: 'enabled', version: 0 });
  const steps: [Change, number, string][] = [
    ['disable', 0, 'disabled'],
    ['disable', 1, 'disabled'],
    ['enable', 1, 'enabled'],
    ['enable', 2, 'enabled'],
    ['disable', 2, 'disabled'],
  ];
  for (const [change, expected_version, status] of steps) {
    const data = await accepted(await s.change(change, row.rule_id, { expected_version }));
    expect(data, `${change}@${expected_version}`).toMatchObject({ status });
  }
  expect(await ruleRow(s, row.rule_id)).toMatchObject({ status: 'disabled', version: 3 });
  expect((await ruleAudits(s)).map((a) => a.action)).toEqual([
    'risk_rule_disable',
    'risk_rule_enable',
    'risk_rule_disable',
  ]);
});
