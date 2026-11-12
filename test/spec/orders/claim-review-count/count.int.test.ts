import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import {
  CREATED,
  claim,
  item,
  log,
  page,
  seed,
  setup,
  type Claim,
  type Scenario,
} from '../claims-admin-read/kit.ts';
import { NONE, NOT_PENDING, evidenceFor, load } from './kit.ts';

const h = useHarness();

/** Settled statuses; claims_evidence_status_check lets them carry evidence_level = strong. */
const SETTLED = ['approved', 'rejected', 'cancelled'] as const;

interface Batch {
  status: string;
  n: number;
  platform?: string;
  weak?: boolean;
  /** Settled claim with evidence_level strong (must still not count as auto_matched). */
  strong?: boolean;
  user?: string;
}

/** Claims through the console claim read kit; each status's evidence follows the db check. */
async function claims(s: Scenario, batches: readonly Batch[]) {
  for (const b of batches) {
    for (let i = 0; i < b.n; i += 1) {
      await seed(s, {
        status: b.status,
        ...(b.strong === true
          ? { evidence_level: 'strong' }
          : evidenceFor(b.status, b.weak ?? false)),
        platform: b.platform ?? 'jd',
        user_id: b.user ?? s.userId,
      });
    }
  }
}

/** Settled claims (approved, rejected, cancelled) that all carry strong evidence. */
function settledStrong(user?: string): Batch[] {
  return SETTLED.map((status) => ({
    status,
    n: 1,
    strong: true,
    ...(user === undefined ? {} : { user }),
  }));
}

/** A claim item with one evidence link log of the applicant (the db requires links for strong/weak). */
async function linked(
  s: Scenario,
  c: Claim,
  patch: { evidence: string; decision?: string; reject_reason?: string },
) {
  const link = await log(s, { user_id: c.user_id, platform: c.platform });
  return item(s, c, {
    evidence_link_log_ids: [link.id],
    ...patch,
    ...(patch.decision === undefined ? {} : { decided_at: CREATED }),
  });
}

/**
 * Two multi-item claims: a manual_review claim with three child orders (one strong, one weak, one
 * already decided) and an auto_matched claim with two strong child orders. Each claim counts once,
 * in its own status: +1 auto_matched, +1 manual_review.
 */
async function multiItem(s: Scenario, user?: string, platform = 'jd') {
  const owner = user ?? s.userId;
  const review = await claim(s, {
    status: 'manual_review',
    evidence_level: 'weak',
    user_id: owner,
    platform,
  });
  await linked(s, review, { evidence: 'strong' });
  await linked(s, review, { evidence: 'weak' });
  await linked(s, review, { evidence: 'weak', decision: 'rejected', reject_reason: 'NO_EVIDENCE' });
  const auto = await claim(s, {
    status: 'auto_matched',
    evidence_level: 'strong',
    user_id: owner,
    platform,
  });
  await linked(s, auto, { evidence: 'strong' });
  await linked(s, auto, { evidence: 'strong' });
}

it('[AC-B1-10v#1] 只计本 app 的 auto_matched 与 manual_review，分项各自正确；其余全部状态与别的 app 不计', async () => {
  const count = await load();
  expect(NOT_PENDING).toEqual(
    expect.arrayContaining(['submitted', 'approved', 'rejected', 'cancelled']),
  );
  expect(NOT_PENDING).toEqual(expect.arrayContaining([...SETTLED]));
  const s = await setup(h);
  const other = await setup(h);
  const second = await seedUser(h.db, s.appId);
  await claims(s, [
    { status: 'auto_matched', n: 1 },
    { status: 'auto_matched', n: 1, user: second, platform: 'pdd' },
    { status: 'manual_review', n: 1, weak: true },
    { status: 'manual_review', n: 1 },
    { status: 'manual_review', n: 1, user: second, platform: 'pdd' },
    ...NOT_PENDING.map((status) => ({ status, n: 2, weak: true })),
    ...NOT_PENDING.map((status) => ({ status, n: 1, user: second, platform: 'pdd' })),
    // Settled claims with strong evidence are not auto_matched: counting by evidence_level is wrong.
    ...settledStrong(),
    ...settledStrong(second),
  ]);
  // Multi-item claims (3 child orders / 2 child orders): each claim counts once, in its own status.
  await multiItem(s);
  await claims(other, [
    { status: 'auto_matched', n: 3 },
    { status: 'manual_review', n: 1 },
    ...NOT_PENDING.map((status) => ({ status, n: 1 })),
  ]);
  expect(await count(h.db, s.appId)).toEqual({
    count: 7,
    breakdown: { auto_matched: 3, manual_review: 4 },
  });
  expect(await count(h.db, other.appId)).toEqual({
    count: 4,
    breakdown: { auto_matched: 3, manual_review: 1 },
  });
  expect(await count(h.db, `claims_${randomUUID().replaceAll('-', '')}`)).toEqual(NONE);
});

it('[AC-B1-10v#2] 没有待审时 count 与两项都是 0；只有一类待审时另一项为 0', async () => {
  const count = await load();
  const empty = await setup(h);
  expect(await count(h.db, empty.appId)).toEqual(NONE);
  await claims(
    empty,
    NOT_PENDING.map((status) => ({ status, n: 1 })),
  );
  expect(await count(h.db, empty.appId)).toEqual(NONE);

  const autoOnly = await setup(h);
  await claims(autoOnly, [
    { status: 'auto_matched', n: 2 },
    { status: 'approved', n: 1 },
  ]);
  expect(await count(h.db, autoOnly.appId)).toEqual({
    count: 2,
    breakdown: { auto_matched: 2, manual_review: 0 },
  });

  const manualOnly = await setup(h);
  await claims(manualOnly, [
    { status: 'manual_review', n: 1, weak: true },
    { status: 'rejected', n: 1 },
  ]);
  expect(await count(h.db, manualOnly.appId)).toEqual({
    count: 1,
    breakdown: { auto_matched: 0, manual_review: 1 },
  });
});

it('[AC-B1-10v#3] 计数等于后台找回列表页：不加筛选的 GET /admin/v1/claims 的 counts.auto_matched + counts.manual_review，两项分别相等', async () => {
  const count = await load();
  const s = await setup(h);
  const other = await setup(h);
  const second = await seedUser(h.db, s.appId);
  await claims(other, [
    { status: 'auto_matched', n: 2 },
    { status: 'manual_review', n: 2 },
  ]);
  const rounds: { batches: Batch[]; multi?: boolean }[] = [
    { batches: [] },
    {
      batches: [
        { status: 'auto_matched', n: 2 },
        { status: 'manual_review', n: 1, weak: true },
        { status: 'manual_review', n: 2, platform: 'pdd', user: second },
        ...NOT_PENDING.map((status) => ({ status, n: 1 })),
      ],
    },
    {
      batches: [
        { status: 'auto_matched', n: 1, platform: 'pdd', user: second },
        { status: 'manual_review', n: 1 },
        ...NOT_PENDING.map((status) => ({ status, n: 1, weak: true, user: second })),
        // Settled claims with strong evidence: the list does not count them as auto_matched.
        ...settledStrong(),
        ...settledStrong(second),
      ],
      // Multi-item claims: the list counts each claim once, by its own status.
      multi: true,
    },
  ];
  for (const round of rounds) {
    await claims(s, round.batches);
    if (round.multi === true) await multiItem(s, second, 'pdd');
    const list = await page(await s.get());
    const card = await count(h.db, s.appId);
    expect(card).toEqual({
      count: list.counts.auto_matched + list.counts.manual_review,
      breakdown: {
        auto_matched: list.counts.auto_matched,
        manual_review: list.counts.manual_review,
      },
    });
  }
  const last = await page(await s.get());
  expect(last.counts).toMatchObject({ auto_matched: 4, manual_review: 5 });
  expect(await count(h.db, s.appId)).toEqual({
    count: 9,
    breakdown: { auto_matched: 4, manual_review: 5 },
  });
});

it('[AC-B1-10v#4] 只读：调用前后 claims、claim_items、orders、link_logs、audit_logs 不变，重复调用结果相同', async () => {
  const count = await load();
  const s = await setup(h);
  const second = await seedUser(h.db, s.appId);
  await claims(s, [
    { status: 'auto_matched', n: 1 },
    { status: 'manual_review', n: 1, weak: true, user: second },
    { status: 'manual_review', n: 1, platform: 'pdd' },
    ...NOT_PENDING.map((status) => ({ status, n: 1 })),
  ]);
  const links = () =>
    h.db.selectFrom('link_logs').selectAll().where('app_id', '=', s.appId).orderBy('id').execute();
  const before = { ...(await s.snapshot()), links: await links() };
  const first = await count(h.db, s.appId);
  const again = await count(h.db, s.appId);
  expect(first).toEqual({ count: 3, breakdown: { auto_matched: 1, manual_review: 2 } });
  expect(again).toEqual(first);
  expect({ ...(await s.snapshot()), links: await links() }).toEqual(before);
});
