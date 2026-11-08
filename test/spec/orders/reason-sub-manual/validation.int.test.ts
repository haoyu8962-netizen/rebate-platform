// B1-09v: what adminCreateRightsImport refuses about `reason_sub` (contract CT-24zw; 08 BR-TEXT-05;
// D10-819 ②): with kind=punish only one of the 12 PUNISH sub-reasons of enum order_reason_sub or
// `none` — a sub-reason of REFUND or RIGHTS, an unknown value, a lower-case spelling or an empty
// part is 20001 with data.fields=[reason_sub]; so is any reason_sub with kind=rights (维权单 has no
// manual choice) or kind=channel. A refused upload writes no rights_imports row, no audit and sends
// no job. Real admin entry, permissions and PostgreSQL. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { form, xlsx } from '../rights-import-task/kit.ts';
import {
  ANSWER,
  CHANNEL_GRANTS,
  CLAIM,
  NONE,
  PUNISH_SUBS,
  REFUND_SUBS,
  RIGHTS_SUBS,
  accepted,
  attributedOrder,
  fieldsError,
  punishFields,
  punishRows,
  refused,
  seedUnionAccount,
  setup,
  upload,
  type Scenario,
} from './kit.ts';

const h = useHarness();

/** Everything a refused upload must leave as it was. */
async function nothingWritten(s: Scenario) {
  const state = await s.state();
  return { imports: state.imports, audits: state.audits, sends: state.sends };
}

const OUTSIDE_PUNISH = [
  ...REFUND_SUBS,
  ...RIGHTS_SUBS,
  'NOT_A_SUB_REASON',
  'fake_trade',
  'Fake_Trade',
  'NONE',
  'None',
  ' FAKE_TRADE',
  '',
] as const;

it.each(OUTSIDE_PUNISH.map((value) => [JSON.stringify(value), value] as const))(
  '[AC-B1-09v#5] kind=punish 带 reason_sub=%s（不在 PUNISH 允许集合与 none 内）：20001 data.fields=[reason_sub]，不写 rights_imports、不写审计、不建任务',
  async (_label, value) => {
    const s = await setup(h, { grants: CLAIM });
    const order = await attributedOrder(s);
    const before = await nothingWritten(s);

    await refused(
      await upload(s, punishFields('jd', value), order.sub_order_id),
      20001,
      fieldsError('reason_sub'),
    );

    expect(await nothingWritten(s)).toEqual(before);
  },
  120_000,
);

it.each([...PUNISH_SUBS.slice(0, 2), NONE])(
  '[AC-B1-09v#5] kind=rights 带 reason_sub=%s（维权单不给人工选，D10-819 ②）：20001 data.fields=[reason_sub]，什么都不写',
  async (value) => {
    const s = await setup(h, { grants: CLAIM });
    const order = await attributedOrder(s);
    const before = await nothingWritten(s);

    await refused(
      await upload(s, { kind: 'rights', platform: 'jd', reason_sub: value }, order.sub_order_id),
      20001,
      fieldsError('reason_sub'),
    );

    expect(await nothingWritten(s)).toEqual(before);
  },
  120_000,
);

it.each(['FAKE_TRADE', NONE])(
  '[AC-B1-09v#5] kind=channel 带 reason_sub=%s（有 risk.blocklist 与有效二次验证）：20001 data.fields=[reason_sub]，什么都不写',
  async (value) => {
    const s = await setup(h, { grants: CHANNEL_GRANTS });
    const accountId = await seedUnionAccount(s);
    const before = await nothingWritten(s);
    const fields = {
      kind: 'channel',
      platform: 'taobao',
      union_account_id: accountId,
      reason_sub: value,
    };

    await refused(
      await upload(s, fields, 'REL-unused', { stepUp: await s.stepUp(s.admin) }),
      20001,
      fieldsError('reason_sub'),
    );

    expect(await nothingWritten(s)).toEqual(before);
  },
  120_000,
);

it('[AC-B1-09v#5] 同一表单里 reason_sub 出现两次：20001 data.fields=[reason_sub]，什么都不写', async () => {
  const s = await setup(h, { grants: CLAIM });
  const order = await attributedOrder(s);
  const before = await nothingWritten(s);
  const parts = [
    ...form({ kind: 'punish', platform: 'jd', reason_sub: 'FAKE_TRADE' }),
    { name: 'reason_sub', value: 'SHOP_TK' },
    ...form({}, xlsx(punishRows([order.sub_order_id]))),
  ];

  await refused(await s.upload(parts), 20001, fieldsError('reason_sub'));

  expect(await nothingWritten(s)).toEqual(before);
}, 120_000);

it.each([...PUNISH_SUBS, NONE])(
  '[AC-B1-09v#5] kind=punish 带允许的 reason_sub=%s：受理（200、queued），rights_imports 存下原值',
  async (value) => {
    const s = await setup(h, { grants: CLAIM });
    const order = await attributedOrder(s);

    const created = await accepted<{ import_id: string; status: string }>(
      await upload(s, punishFields('jd', value), order.sub_order_id),
      ANSWER.punish,
    );

    expect(created.status).toBe('queued');
    const rows = (await s.state()).imports;
    expect(rows.map((row) => [row.id, row.kind, row.reason_sub])).toEqual([
      [created.import_id, 'punish', value],
    ]);
  },
  120_000,
);
