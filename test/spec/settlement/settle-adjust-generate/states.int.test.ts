// B2-09zb rule tests (claude-independent, SPEC_REF 18f0015): the beneficiary states in the positive
// route (08 BR-CALC-09: frozen / appealing 的正向差额延后、状态解除后再按当时状态处理；封禁、已注销的正向差额
// 归平台、新应得取重拆份额与已有净额中较小的一个; BR-FUND-09: 正差一路里不出现受益人负差; D10-770 ②:
// the state is decided again at approval). The candidate run (task §9): a frozen or appealing
// beneficiary's row is written as usual; a banned or deleting / deleted beneficiary gets no row, the
// share is in the platform row. Example: 1234 (617 / 123 / 494) → 1300 (650 / 130 / 520).
import { expect, it } from 'vitest';
import {
  EXAMPLE,
  TIMEOUT,
  adjustHarness,
  beneficiaryRow,
  createDatabase,
  databaseFixture,
  ordered,
  platformRow,
} from './harness.ts';

const p = databaseFixture(createDatabase);

it(
  '[AC-B2-09zb#4] 冻结受益人：照常写他的行（+33），平台行 +26、直推 +7；不写凭证、不开待补记义务',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    await h.risk(o.user('self'), 'frozen');
    const before = await h.state();

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#4] 申诉中受益人同冻结：照常写他的行',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    await h.risk(o.user('direct'), 'appealing');

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(26n, seq),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#4] 封禁受益人：不写他的行，他的 +33 并入平台行（+59）；直推 +7 照常',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    await h.risk(o.user('self'), 'banned');
    const before = await h.state();

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(59n, seq),
    ]);
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#4] 注销处理中的受益人同封禁：不写他的行，份额并入平台行',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    await h.markDeleting(o.user('self'));

    await h.run();

    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'direct', 7n, seq),
      platformRow(59n, seq),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zb#4] 已注销的受益人同封禁：不写他的行，份额并入平台行',
  async () => {
    const h = await adjustHarness(p.db);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    await h.markDeleted(o.user('direct'));

    await h.run();

    // direct's +7 goes to the platform: 26 + 7.
    expect(ordered(await h.rowsOf(o))).toEqual([
      beneficiaryRow(o, 'self', 33n, seq),
      platformRow(33n, seq),
    ]);
  },
  TIMEOUT,
);
