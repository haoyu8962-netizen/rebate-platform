// B2-09zh rule tests (claude-independent, SPEC_REF 29c27a1b): W8 打款时间早于审核时间打标告警
// (FU-W8-PAID-BEFORE-REVIEW, 08 BR-WDR-16, 编排裁定 D10-678 ①). A payment made offline may really predate the
// click on 「通过」, so W8 does not refuse it: paid_at strictly before withdrawals.reviewed_at adds
// paid_before_review: true to the `after` of the audit withdrawal_manual_paid and logs one warn
// payout_manual_paid_before_review carrying app_id and withdrawal_id only, for 运营复核. Everything else
// (answer, status, money, voucher, balance, tax, notification) is what an unflagged item gets.
// Requests go through the real admin entry (../admin-manual-paid/manual-paid-harness.ts, imported only).
// That harness builds the entry's root logger itself, silent; the mock below replaces just that one
// logger with the real createRootLogger writing to memory, so the pino lines read here are the real ones.
// Every it() ends on, or contains, an item that must be flagged, so each is red before the rule exists
// (规划/11 §4.3: top-level it() only; D10-678 ①: the unflagged cases are green on the old code alone).
import { expect, it, vi } from 'vitest';
import {
  ACCOUNT,
  ACTION,
  AFTER_FREEZE,
  AMOUNT,
  FEE,
  NET,
  RICH,
  TAX,
  ago,
  answer,
  approved,
  asPaidManual,
  auditFacts,
  audits,
  balanceOf,
  changes,
  entries,
  entryOf,
  expectItems,
  expectNoSecrets,
  fixture,
  frozenMismatches,
  member,
  newKey,
  paid,
  payee,
  platformLine,
  reviewing,
  rowOf,
  secretsOf,
  serial,
  skipped,
  state,
  suite,
  taxOf,
  userLine,
  voucherOf,
  withManualAdmin,
  withOffset,
  type ManualAdmin,
  type ReviewFixture,
  type WithdrawalRow,
} from '../admin-manual-paid/manual-paid-harness.ts';

const capture = vi.hoisted(() => ({ lines: [] as string[], swapped: 0 }));

vi.mock('../../../../apps/api/src/modules/platform/logging/logger.ts', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../../../../apps/api/src/modules/platform/logging/logger.ts')
    >();
  const createRootLogger: typeof original.createRootLogger = (options, destination) => {
    if (options.entry !== 'admin' || options.level !== 'silent') {
      return original.createRootLogger(options, destination);
    }
    capture.swapped += 1;
    return original.createRootLogger(
      { ...options, level: 'info' },
      { write: (line: string) => void capture.lines.push(line) },
    );
  };
  return { ...original, createRootLogger };
});

const s = suite();

const WARNING = 'payout_manual_paid_before_review';
const FLAG = 'paid_before_review';
const PINO_WARN = 40;
/** What the logger itself binds to every line; the rest is what the call site chose to log. */
const LOGGER_FIELDS = new Set(['level', 'time', 'pid', 'entry', 'env', 'deployVersion', 'module']);

/** withManualAdmin with the entry's log captured from an empty start. */
async function scenario(f: ReviewFixture, body: (h: ManualAdmin) => Promise<void>): Promise<void> {
  capture.lines.length = 0;
  capture.swapped = 0;
  await withManualAdmin(f, body);
  expect(capture.swapped, '夹具的 admin 根 logger 必须被捕获').toBe(1);
}

/** The instant `deltaMs` after `at`, as the request sends it. */
function around(at: Date, deltaMs: number): string {
  return withOffset(new Date(at.getTime() + deltaMs));
}

function warnings(): Record<string, unknown>[] {
  return capture.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['msg'] === WARNING);
}

function warnedIds(): unknown[] {
  return warnings().map((record) => record['withdrawal_id']);
}

/** The `after` of the one audit withdrawal_manual_paid of this withdrawal. */
async function auditAfter(f: ReviewFixture, id: string): Promise<Record<string, unknown>> {
  const records = (await audits(f, ACTION)).filter((record) =>
    auditFacts(record).text.includes(id),
  );
  expect(records, `withdrawal_manual_paid of ${id}`).toHaveLength(1);
  const after: unknown = records[0]!.after;
  return after as Record<string, unknown>;
}

async function expectFlagged(f: ReviewFixture, id: string): Promise<void> {
  expect((await auditAfter(f, id))[FLAG], `${FLAG} of ${id}`).toBe(true);
}

async function expectNotFlagged(f: ReviewFixture, id: string): Promise<void> {
  expect(await auditAfter(f, id), `${FLAG} of ${id}`).not.toHaveProperty(FLAG);
}

/** A fresh withdrawal paid 1 ms before its review: it must be flagged and warned about, once. */
async function expectControlFlagged(f: ReviewFixture, h: ManualAdmin): Promise<void> {
  const reviewedAt = ago(f, 20);
  const control = await approved(f, h, await payee(f, h), { reviewed_at: reviewedAt });
  await expectItems(
    await h.manualPaid([entryOf(f, control, { paid_at: around(reviewedAt, -1) })]),
    [paid(control.id)],
  );
  await expectFlagged(f, control.id);
  expect(warnedIds()).toEqual([control.id]);
}

function moneyOf(row: WithdrawalRow) {
  return {
    status: row.status,
    amount_fen: row.amount_fen,
    net_fen: row.net_fen,
    fee_fen: row.fee_fen,
    tax_fen: row.tax_fen,
  };
}

it('[AC-B2-09zh#1] paid_at 早 reviewed_at 1 毫秒：不拒绝，应答 paid、单到 PAID_MANUAL；审计 after.paid_before_review === true；恰一条 warn payout_manual_paid_before_review，字段只有 app_id、withdrawal_id，不含流水号、手机号、收款账户', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const who = await payee(f, h);
    const reviewedAt = ago(f, 20);
    const w = await approved(f, h, who, { reviewed_at: reviewedAt });
    const entry = entryOf(f, w, { paid_at: around(reviewedAt, -1) });

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    await expectFlagged(f, w.id);
    const logged = warnings();
    expect(logged).toHaveLength(1);
    const record = logged[0]!;
    expect(record['level']).toBe(PINO_WARN);
    const own = Object.entries(record).filter(([key]) => key !== 'msg' && !LOGGER_FIELDS.has(key));
    expect(Object.fromEntries(own)).toEqual({ app_id: f.appId, withdrawal_id: w.id });
    expectNoSecrets(JSON.stringify(record), [
      entry.channel_order_id,
      ...secretsOf(w, ACCOUNT.alipay, who),
    ]);
  });
});

it('[AC-B2-09zh#2] paid_at 等于 reviewed_at（边界，只有严格早于才算）：应答 paid，审计 after 没有该键、没有该 warn；同一用例再补一笔早 1 毫秒的必须打标', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const reviewedAt = ago(f, 20);
    const w = await approved(f, h, await payee(f, h), { reviewed_at: reviewedAt });

    await expectItems(await h.manualPaid([entryOf(f, w, { paid_at: around(reviewedAt, 0) })]), [
      paid(w.id),
    ]);

    await expectNotFlagged(f, w.id);
    expect(warnedIds()).toEqual([]);
    await expectControlFlagged(f, h);
  });
});

it('[AC-B2-09zh#3] paid_at 晚于 reviewed_at（晚 1 毫秒）：应答 paid，不打标、无 warn；同一用例再补一笔早 1 毫秒的必须打标', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const reviewedAt = ago(f, 20);
    const w = await approved(f, h, await payee(f, h), { reviewed_at: reviewedAt });

    await expectItems(await h.manualPaid([entryOf(f, w, { paid_at: around(reviewedAt, 1) })]), [
      paid(w.id),
    ]);

    await expectNotFlagged(f, w.id);
    expect(warnedIds()).toEqual([]);
    await expectControlFlagged(f, h);
  });
});

it('[AC-B2-09zh#4] reviewed_at 为 null（未经人工审核的单）：应答 paid，不打标、无 warn；同一用例再补一笔早 1 毫秒的必须打标', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const w = await approved(f, h, await payee(f, h), {
      review_mode: 'auto',
      reviewer_id: null,
      reviewed_at: null,
    });

    await expectItems(await h.manualPaid([entryOf(f, w)]), [paid(w.id)]);

    await expectNotFlagged(f, w.id);
    expect(warnedIds()).toEqual([]);
    await expectControlFlagged(f, h);
  });
});

it('[AC-B2-09zh#5] 打标不改变资金结果：同额两笔、两个会员，一笔早于审核一笔晚于，状态、金额、PAID 凭证与分录、余额、tax_ytd、事件逐项相等；只有前者打标', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const flaggedMember = await payee(f, h);
    const plainMember = await payee(f, h);
    const reviewedAt = ago(f, 20);
    const flagged = await approved(f, h, flaggedMember, { reviewed_at: reviewedAt });
    const plain = await approved(f, h, plainMember, { reviewed_at: reviewedAt });
    const flaggedEntry = entryOf(f, flagged, { paid_at: around(reviewedAt, -1) });
    const plainEntry = entryOf(f, plain, { paid_at: around(reviewedAt, 1) });

    await expectItems(await h.manualPaid([flaggedEntry, plainEntry]), [
      paid(flagged.id),
      paid(plain.id),
    ]);

    const flaggedRow = await rowOf(f, flagged);
    const plainRow = await rowOf(f, plain);
    expect(flaggedRow).toEqual(asPaidManual(f, flagged, flaggedEntry, h.entry.id));
    expect(plainRow).toEqual(asPaidManual(f, plain, plainEntry, h.entry.id));
    const money = {
      status: 'PAID_MANUAL',
      amount_fen: AMOUNT,
      net_fen: NET,
      fee_fen: FEE,
      tax_fen: TAX,
    };
    expect(moneyOf(flaggedRow)).toEqual(money);
    expect(moneyOf(plainRow)).toEqual(money);

    const lines = [
      userLine(88n, 'TAX_WITHHOLD'),
      platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
      userLine(125n, 'WITHDRAW_FEE'),
      platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
      userLine(12_347n, 'WITHDRAW_PAID'),
      platformLine('CASH_ALIPAY', -12_347n, 'WITHDRAW_PAID'),
    ];
    for (const row of [flagged, plain]) {
      const key = `wd:${row.id}:PAID`;
      expect(await voucherOf(f.db, f.appId, key)).toEqual([
        { uniq_key: key, biz_type: 'withdrawal', biz_id: row.id, operator: `admin:${h.entry.id}` },
      ]);
      expect(await entries(f.db, f.appId, key)).toEqual(lines);
    }

    for (const who of [flaggedMember, plainMember]) {
      expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
        available_fen: AFTER_FREEZE,
        frozen_fen: 0n,
      });
      expect(await taxOf(f, who)).toEqual([
        {
          year: 2026,
          income_type: 'SERVICE_FEE',
          identity_hmac: who.hmac,
          cum_income_fen: 12_560n,
          cum_withheld_fen: 88n,
        },
      ]);
    }
    const events = await changes(f.db, f.appId);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { withdrawal_id: flagged.id, user_id: flaggedMember.userId, status: 'PAID_MANUAL' },
        { withdrawal_id: plain.id, user_id: plainMember.userId, status: 'PAID_MANUAL' },
      ]),
    );
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);

    await expectNotFlagged(f, plain.id);
    await expectFlagged(f, flagged.id);
    expect(warnedIds()).toEqual([flagged.id]);
  });
});

it('[AC-B2-09zh#6] 同一批一笔早于、一笔不早于：各自判断，只有前者打标，只告警一次', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const who = await payee(f, h);
    const reviewedAt = ago(f, 20);
    const early = await approved(f, h, who, { reviewed_at: reviewedAt });
    const notEarly = await approved(f, h, who, { reviewed_at: reviewedAt });

    await expectItems(
      await h.manualPaid([
        entryOf(f, notEarly, { paid_at: around(reviewedAt, 0) }),
        entryOf(f, early, { paid_at: around(reviewedAt, -1) }),
      ]),
      [paid(notEarly.id), paid(early.id)],
    );

    await expectNotFlagged(f, notEarly.id);
    await expectFlagged(f, early.id);
    expect(warnedIds()).toEqual([early.id]);
  });
});

it('[AC-B2-09zh#7] 被拒绝的项（not_approved、channel_order_id_taken、amount_mismatch、identity_missing）即使 paid_at 早于 reviewed_at 也不告警、不写审计、单不动；同批可补的那笔照常打标告警', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const who = await payee(f, h);
    const reviewedAt = ago(f, 20);
    const early = around(reviewedAt, -1);
    const taken = serial();
    await reviewing(f, h, who, { status: 'PAID_API', channel_order_id: taken });
    const rejected = await reviewing(f, h, who, { status: 'REJECTED', reviewed_at: reviewedAt });
    const collides = await approved(f, h, who, { reviewed_at: reviewedAt });
    const wrongAmount = await approved(f, h, who, { reviewed_at: reviewedAt });
    const noIdentity = await approved(f, h, await member(f, h, RICH), { reviewed_at: reviewedAt });
    const control = await approved(f, h, who, { reviewed_at: reviewedAt });
    const refused = [rejected, collides, wrongAmount, noIdentity];

    await expectItems(
      await h.manualPaid([
        entryOf(f, rejected, { paid_at: early }),
        entryOf(f, collides, { paid_at: early, channel_order_id: taken }),
        entryOf(f, wrongAmount, { paid_at: early, paid_fen: 1 }),
        entryOf(f, noIdentity, { paid_at: early }),
        entryOf(f, control, { paid_at: early }),
      ]),
      [
        skipped(rejected.id, 'not_approved'),
        skipped(collides.id, 'channel_order_id_taken'),
        skipped(wrongAmount.id, 'amount_mismatch'),
        skipped(noIdentity.id, 'identity_missing'),
        paid(control.id),
      ],
    );

    for (const row of refused) expect(await rowOf(f, row)).toEqual(row);
    const texts = (await audits(f, ACTION)).map((record) => auditFacts(record).text);
    expect(texts).toHaveLength(1);
    expect(texts.filter((text) => refused.some((row) => text.includes(row.id)))).toEqual([]);
    expect(warnedIds().filter((id) => refused.some((row) => row.id === id))).toEqual([]);
    await expectFlagged(f, control.id);
    expect(warnedIds()).toEqual([control.id]);
  });
});

it('[AC-B2-09zh#8] 同键重放：第一次的结果原样回放（应答字节相同、库里什么都不多），不重复审计、不重复告警', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const reviewedAt = ago(f, 20);
    const w = await approved(f, h, await payee(f, h), { reviewed_at: reviewedAt });
    const items = [entryOf(f, w, { paid_at: around(reviewedAt, -1) })];
    const key = newKey();

    const sent = await h.manualPaid(items, { key });
    await expectItems(sent, [paid(w.id)]);
    await expectFlagged(f, w.id);
    expect(warnedIds()).toEqual([w.id]);
    const after = await state(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.manualPaid(items, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }

    expect(await state(f)).toEqual(after);
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(warnedIds()).toEqual([w.id]);
  });
});

it('[AC-B2-09zh#9] 事务回滚的单不告警：一批两笔都早于审核时间，第二笔写审计失败 → 50001，只告警已提交的第一笔，第二笔仍 APPROVED；同键重试第一笔 not_approved、第二笔 paid，每笔恰告警一次', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const who = await payee(f, h);
    const reviewedAt = ago(f, 20);
    const first = await approved(f, h, who, { reviewed_at: reviewedAt });
    const second = await approved(f, h, who, { reviewed_at: reviewedAt });
    const early = around(reviewedAt, -1);
    const items = [entryOf(f, first, { paid_at: early }), entryOf(f, second, { paid_at: early })];
    const key = newKey();

    h.fault.point = 'audit';
    h.fault.contains = second.id;
    const sent = await h.manualPaid(items, { key });

    expect(h.fault.tripped, '第 2 项的审计必须在它自己的事务里写').toBe(1);
    await answer(sent, 50001);
    expect(await rowOf(f, first)).toEqual(asPaidManual(f, first, items[0]!, h.entry.id));
    expect(await rowOf(f, second)).toEqual(second);
    expect(await audits(f, ACTION)).toHaveLength(1);
    await expectFlagged(f, first.id);
    expect(warnedIds()).toEqual([first.id]);

    await expectItems(await h.manualPaid(items, { key }), [
      skipped(first.id, 'not_approved'),
      paid(second.id),
    ]);

    expect(await rowOf(f, second)).toEqual(asPaidManual(f, second, items[1]!, h.entry.id));
    expect(await audits(f, ACTION)).toHaveLength(2);
    await expectFlagged(f, first.id);
    await expectFlagged(f, second.id);
    expect(warnedIds()).toEqual([first.id, second.id]);
  });
});

it('[AC-B2-09zh#10] 毫秒精度：reviewed_at 带 500 毫秒，paid_at 为同一秒的 .000 必须打标告警（按秒截断比较不算）；同一 reviewed_at 上早 1 毫秒打标告警，相等与晚 1 毫秒不打标不告警', async () => {
  const f = fixture(s);
  await scenario(f, async (h) => {
    const who = await payee(f, h);
    const wholeSecond = ago(f, 20);
    expect(wholeSecond.getUTCMilliseconds(), '夹具时钟必须是整秒').toBe(0);
    const reviewedAt = new Date(wholeSecond.getTime() + 500);
    const sameSecond = await approved(f, h, who, { reviewed_at: reviewedAt });
    const justBefore = await approved(f, h, who, { reviewed_at: reviewedAt });
    const equal = await approved(f, h, who, { reviewed_at: reviewedAt });
    const justAfter = await approved(f, h, who, { reviewed_at: reviewedAt });
    expect((await rowOf(f, sameSecond)).reviewed_at, '种子必须带毫秒入库').toEqual(reviewedAt);

    await expectItems(
      await h.manualPaid([
        entryOf(f, sameSecond, { paid_at: withOffset(wholeSecond) }),
        entryOf(f, justBefore, { paid_at: around(reviewedAt, -1) }),
        entryOf(f, equal, { paid_at: around(reviewedAt, 0) }),
        entryOf(f, justAfter, { paid_at: around(reviewedAt, 1) }),
      ]),
      [paid(sameSecond.id), paid(justBefore.id), paid(equal.id), paid(justAfter.id)],
    );

    await expectNotFlagged(f, equal.id);
    await expectNotFlagged(f, justAfter.id);
    await expectFlagged(f, sameSecond.id);
    await expectFlagged(f, justBefore.id);
    expect(warnedIds()).toEqual([sameSecond.id, justBefore.id]);
  });
});
