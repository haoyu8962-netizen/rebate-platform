// B2-04zzb property (BR-FUND-04 ⑫): over any booked commission O and any lower new commission N
// (small and above 2^31 fen, odd and even, down to 0 and 1) and any forfeiting state, the
// obligation R9 / R10 forfeits references exactly the platform voucher that transaction wrote, and
// has no voucher when the platform difference is 0 (closed_ref then names the event); when N leaves
// no base (0 or 1 fen: N⁺ = 0 or B_new = 0) the transaction is R8 instead and the obligation is
// voided with no voucher although an R8 platform voucher is written.
// Runs and seed come from @couli/testing only (DB-backed: PROP_RUNS / 100, at least 20, as the
// credit property does). Expected values are derived in the body from BR-CALC-02 / BR-CALC-04,
// reserve 1500 on both entries, B = floor(N × 8500 / 10000):
//   R9 entry (credit kit, a successful rights record bringing N): self = floor(B × 5000 / 10000),
//   direct = floor(B × 1000 / 10000), indirect = floor(B × 500 / 10000). Direct is held at credit
//   (pending = its share) then forfeiting; self and indirect are credited; platform credit = O −
//   self − direct − indirect. After N with B_new ≥ 1: direct's share goes to the platform, so
//   platform new = N − self_new − indirect_new.
//   R10 entry (ordinary sync on the assembled worker, sync-kit.ts: the union's report carries N,
//   recordApi writes seq 2): one beneficiary, the member (own share 50 %: share = floor(B × 5000 /
//   10000)), held at credit then forfeiting; platform credit = O − share. After N with B_new ≥ 1
//   the member's share goes to the platform: platform new = N.
// The difference is platform new − platform credit (a platform voucher exactly when that is not 0).
// With B_new = 0 (BR-FUND-08 / BR-FUND-01 R8): every net is clawed back, the obligation voided
// (closed_by R8; closed_ref R{id} on the R9 entry, C{commission_version} on the R10 entry).
import { createTestDatabase } from '@couli/db/testing';
import { addFen, mulDivFloor, subFen } from '@couli/money';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  FORFEITING,
  TIMEOUT,
  baseOf,
  databaseFixture,
  harness,
  people,
  platformClawbackKey,
  shareOf,
  type Harness,
  type LaterState,
} from './kit.ts';
import {
  expectSyncLinked,
  heldThenSynced,
  memberObligation,
  settled,
  syncPlatformAdjKey,
  syncPlatformClawbackKey,
  syncVouchersByKey,
  touched,
  withSync,
  type Worker,
} from './sync-kit.ts';

const p = databaseFixture(createTestDatabase);

/** 2^31 + 1 fen: amounts from here up must reach the real chain (no 32-bit narrowing anywhere). */
const ABOVE_INT32_FEN = 2_147_483_649n;
/** 2^32 + 1 fen. */
const ABOVE_UINT32_FEN = 4_294_967_297n;
/** 2^40 fen: upper end of the generated booked commission, far below int64 / JSON-safe limits. */
const MAX_ORIGINAL_FEN = 1_099_511_627_776n;

/** BR-CALC-02 / BR-CALC-04 split of the default order (reserve 1500; 5000 / 1000 / 500). */
function split(n: bigint) {
  const { base } = baseOf(n, 1500);
  return {
    base,
    self: shareOf(base, 5000),
    direct: shareOf(base, 1000),
    indirect: shareOf(base, 500),
  };
}

/** BR-CALC-02 / BR-CALC-04 split of the worker-kit member order (reserve 1500; own share 5000). */
function memberSplit(n: bigint) {
  const { base } = baseOf(n, 1500);
  return { base, share: shareOf(base, 5000) };
}

/** The worker-kit N whose R10 leaves the platform where it was: N = O − share(O). */
function memberFlat(o: bigint): Amounts {
  return pair(o, subFen(o, memberSplit(o).share));
}

interface Amounts {
  /** Booked commission at credit (orders.settle_commission_fen of the seeded order). */
  readonly original: bigint;
  /** The union's new commission brought by R9 (rights) or R10 (new settlement record). */
  readonly next: bigint;
}

const original = fc.oneof(
  fc.bigInt({ min: 1000n, max: 99_999n }),
  fc.bigInt({ min: ABOVE_INT32_FEN, max: MAX_ORIGINAL_FEN }),
);

function pair(o: bigint, n: bigint): Amounts {
  return { original: o, next: n };
}

/** An N below O (≥ 12), any or forced odd (2k + 1: the floor of an odd N × 8500 / 10000). */
function below(o: bigint): fc.Arbitrary<Amounts> {
  const top = subFen(o, 1n);
  const any = fc.bigInt({ min: 12n, max: top });
  const odd = fc
    .bigInt({ min: 6n, max: mulDivFloor(subFen(top, 1n), 1n, 2n) })
    .map((k) => addFen(addFen(k, k), 1n));
  return fc.oneof(any, odd).map((n) => pair(o, n));
}

/** N < O with B_new strictly below the booked base and direct's new share ≥ 1 (B_new ≥ 10). */
function lowerBase(a: Amounts): boolean {
  const next = split(a.next).base;
  return a.next < a.original && next < split(a.original).base && next >= 10n;
}

const lowered: fc.Arbitrary<Amounts> = original.chain(below).filter(lowerBase);

/** N = 0 (N⁺ = 0) or N = 1 (B_new = 0 while the booked base is > 0): R8 on either entry. */
const zeroed = fc.tuple(original, fc.constantFrom(0n, 1n)).map(([o, n]) => pair(o, n));

const amounts = fc.oneof(
  // platform difference 0 on the R9 entry: 840 on 1000 → platform new 840 − 357 − 35 = 448 =
  // platform credit
  fc.constant<Amounts>({ original: 1000n, next: 840n }),
  // platform difference 0 on the R10 entry (worker member order): 575 on 1000 → platform new 575 =
  // platform credit 1000 − 425; the same above 2^31 (2^32 + 1 → 2469606196) and for any O
  fc.constant<Amounts>({ original: 1000n, next: 575n }),
  fc.constant<Amounts>(memberFlat(ABOVE_UINT32_FEN)),
  original.map(memberFlat),
  // odd on both sides: B 850 → 849
  fc.constant<Amounts>({ original: 1001n, next: 999n }),
  // above 2^31 on both sides
  fc.constant<Amounts>({ original: ABOVE_UINT32_FEN, next: ABOVE_INT32_FEN }),
  fc.constant<Amounts>({ original: 1000n, next: 0n }),
  fc.constant<Amounts>({ original: 1000n, next: 1n }),
  lowered,
  zeroed,
);

/** The R9 entry: a successful rights record bringing N on a credit-kit order, direct forfeiting. */
async function checkR9(h: Harness, sample: Amounts, state: LaterState) {
  const { original: originalFen, next: n } = sample;
  const o = await h.credited({
    settleFen: originalFen,
    people: people({ direct: 'frozen' }),
  });
  await h.setState(o, 'direct', state);
  const opened = await h.obligationOf(o, 'direct');
  expect(opened).toMatchObject({ kind: 'first_credit', status: 'open', voucher_id: null });
  const before = split(originalFen);
  const after = split(n);

  const { result, eventId } = await h.rightsR9(o, n);
  const key = platformClawbackKey(o, eventId);

  if (after.base === 0n) {
    // BR-FUND-08 / BR-FUND-01 R8: whole order clawed back, the unfinished obligation voided with no
    // voucher (beneficiary_credits_voucher_check), though R8 writes its platform voucher.
    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R8' });
    expect(await h.platformKeys(o)).toContain(key);
    expect(await h.obligationOf(o, 'direct')).toMatchObject({
      beneficiary_credit_id: opened.beneficiary_credit_id,
      status: 'voided',
      closed_by: 'R8',
      closed_ref: eventId,
      voucher_id: null,
    });
    return;
  }
  const platformCredit = subFen(
    subFen(subFen(originalFen, before.self), before.direct),
    before.indirect,
  );
  const platformNew = subFen(subFen(n, after.self), after.indirect);
  const delta = subFen(platformNew, platformCredit);
  expect(result).toMatchObject({
    outcome: 'clawed_back',
    transition: 'R9',
    bookedBaseFen: after.base,
    bookedNFen: n,
  });
  if (delta === 0n) {
    expect(await h.platformKeys(o)).not.toContain(key);
    expect(await h.obligationOf(o, 'direct')).toMatchObject({
      beneficiary_credit_id: opened.beneficiary_credit_id,
      status: 'forfeited',
      closed_by: 'R9',
      closed_ref: eventId,
      voucher_id: null,
    });
    return;
  }
  await h.expectLinked(o, 'direct', {
    closedBy: 'R9',
    closedRef: eventId,
    uniqKey: key,
    kind: 'CLAWBACK',
  });
}

/**
 * The R10 entry: the ordinary sync on the assembled worker, the union's report carrying N (recordApi
 * writes seq 2, the record deciding the amount), on a worker-kit member order held at credit and
 * then forfeiting.
 */
async function checkR10(w: Worker, sample: Amounts, state: LaterState) {
  const { original: originalFen, next: n } = sample;
  const { app, o, read, opened } = await heldThenSynced(p.db, w, state, {
    n: originalFen,
    reserveBp: 1500,
  });
  const before = memberSplit(originalFen);
  const after = memberSplit(n);

  await o.sync(settled(n, touched(1)));
  const row = await o.row();

  if (after.base === 0n) {
    // BR-FUND-09 → BR-FUND-08 / BR-FUND-01 R8 (event C{commission_version}, the version the sync
    // moved to): the obligation voided with no voucher, though R8 writes its platform voucher.
    const closedRef = `C${String(row.commission_version)}`;
    expect(row).toMatchObject({ rebate_status: 'CLAWED_BACK', booked_base_fen: 0n });
    expect(await syncVouchersByKey(p.db, app, syncPlatformClawbackKey(o, closedRef))).toHaveLength(
      1,
    );
    expect(await memberObligation(read)).toMatchObject({
      beneficiary_credit_id: opened.beneficiary_credit_id,
      status: 'voided',
      closed_by: 'R8',
      closed_ref: closedRef,
      voucher_id: null,
    });
    return;
  }
  const platformCredit = subFen(originalFen, before.share);
  const delta = subFen(n, platformCredit);
  expect(row).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: after.base,
    booked_n_fen: n,
  });
  expect(await read.history()).toMatchObject([{ event: 'SETTLE_NEGATIVE_DIFF' }]);
  const key = syncPlatformAdjKey(o, 2);
  if (delta === 0n) {
    expect(await syncVouchersByKey(p.db, app, key)).toEqual([]);
    expect(await memberObligation(read)).toMatchObject({
      beneficiary_credit_id: opened.beneficiary_credit_id,
      status: 'forfeited',
      closed_by: 'R10',
      closed_ref: 'S2',
      voucher_id: null,
    });
    return;
  }
  await expectSyncLinked(p.db, app, o, read, { closedRef: 'S2', uniqKey: key });
}

it('[AC-B2-04zzb#19] 属性：任意入账佣金 O（1000～99999 与大于 2^31 分）与更低的新佣金 N（含奇数、大于 2^31、平台差额为 0 的情形，以及 0 与 1 分）、任意没收状态（封禁 / 注销中 / 已注销）、R9（维权带新佣金）或 R10（普通同步：组装好的同步 worker，联盟报文带新结算金额、recordApi 写记录 seq 2）：新基数 ≥ 1 时被没收义务的 voucher_id 恰为本事务平台凭证的 id（平台差额 ≠ 0），平台差额为 0 时为 null 且不写平台凭证，closed_ref 恒为该事务的 rights_event_id / S{seq}；N 为 0 或 1（新基数为 0）时两条入口都是 R8，写平台扣回凭证但义务 voided / closed_by R8、voucher_id 为 null', async () => {
  const h = await harness(p.db);
  const params = propParams();
  const runs = Math.max(20, Math.floor(params.numRuns / 100));
  let checked = 0;
  await withSync(p.db, async (w) => {
    await fc.assert(
      fc.asyncProperty(
        amounts,
        fc.constantFrom(...FORFEITING),
        fc.constantFrom('R9' as const, 'R10' as const),
        async (sample, [state], transition) => {
          if (transition === 'R9') await checkR9(h, sample, state);
          else await checkR10(w, sample, state);
          checked += 1;
          return true;
        },
      ),
      { ...params, numRuns: runs },
    );
  });
  expect(checked).toBe(runs);
}, 900_000);

it(
  '[AC-B2-04zzb#20] 生成器边界：840 时平台新净额恰为 448（差额 0），600 时为 320（差额 −128），999 时为 533（差额 +85，平台凭证为 INCREASE）；经真实入口 R9：840 不写平台凭证、义务不关联，999 关联其平台扣回凭证',
  async () => {
    const h = await harness(p.db);
    for (const [n, platformNew] of [
      [840n, 448n],
      [600n, 320n],
      [999n, 533n],
    ] as const) {
      const { base } = baseOf(n, 1500);
      expect(subFen(subFen(n, shareOf(base, 5000)), shareOf(base, 500)), String(n)).toBe(
        platformNew,
      );
    }
    // 840 through R9 on the real entry: no platform voucher, the obligation unlinked; 999 linked.
    const flat = await h.heldThen({ direct: 'banned' });
    const zero = await h.rightsR9(flat, 840n);
    expect(await h.platformKeys(flat)).toEqual([`${flat.orderKey}:PLATFORM:CREDIT`]);
    expect((await h.obligationOf(flat, 'direct')).voucher_id).toBeNull();
    expect(zero.result).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    const up = await h.heldThen({ direct: 'banned' });
    const raised = await h.rightsR9(up, 999n);
    await h.expectLinked(up, 'direct', {
      closedBy: 'R9',
      closedRef: raised.eventId,
      uniqKey: platformClawbackKey(up, raised.eventId),
      kind: 'CLAWBACK',
    });
  },
  TIMEOUT,
);
