// B2-12c in-app message only (claude-independent; spec-test r1 S1 on message.int.test.ts #30):
// BR-FUND-24 ⑦ (调减另发站内信) and BR-TEXT-19 站内信 BALANCE_ADJUSTED — the member gets the in-app
// message and nothing on an outside channel: after a successful decrease and after a reversal that
// decreases the balance, notify_logs of the app holds no push or sms row for the member, no queued job
// (pgboss.job) names the member for push or sms, and the inbox holds exactly one BALANCE_ADJUSTED
// message per decrease. Texts are written out from the rules (kit.ts messageBody), never from the code.
// Amounts by hand: 3000; −120 → 2880; seeded +500 → 3380; its reversal −500 → 2880.
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  MESSAGE_CODE,
  MESSAGE_TITLE,
  answer,
  fixture,
  inboxOf,
  member,
  messageBody,
  moneyOf,
  newForm,
  seedForm,
  seedReconDiff,
  suite,
  withAdjustAdmin,
  type AdjustFixture,
  type Ref,
} from './kit.ts';

const s = suite();

/** notify_logs rows of the app on the push or sms channel naming the member. */
async function outsideLogs(f: AdjustFixture, userId: string) {
  return f.db
    .selectFrom('notify_logs')
    .select(['code', 'channel', 'status', 'dedupe_key'])
    .where('app_id', '=', f.appId)
    .where('user_id', '=', userId)
    .where('channel', 'in', ['push', 'sms'])
    .execute();
}

/** Queued jobs that name the member and are about push or sms (queue name or a channel field). */
async function outsideJobs(userId: string, f: AdjustFixture) {
  const result = await sql<{ name: string; data: unknown }>`
    SELECT name, data FROM pgboss.job
    WHERE data::text LIKE ${`%${userId}%`}
      AND (name ~* '(push|sms)'
        OR data::text ~* '"channel"[[:space:]]*:[[:space:]]*"(push|sms)"')`.execute(f.db);
  return result.rows;
}

async function expectInAppOnly(f: AdjustFixture, userId: string, label: string): Promise<void> {
  expect(await outsideLogs(f, userId), `${label}：不写 push / sms 的 notify_logs`).toEqual([]);
  expect(await outsideJobs(userId, f), `${label}：不投递 push / sms 任务`).toEqual([]);
}

it('[AC-B2-12c#44] 成功调减（−120 RECON_FIX）与调减方向的红冲（冲回 +500 RECON_FIX）各给会员恰好一条站内信 BALANCE_ADJUSTED，正文按 BR-TEXT-19；notify_logs 里没有该会员 push、sms 渠道的记录，也没有投递 push、sms 的任务', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };

    await answer(
      await h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount: 120n,
          reason: 'RECON_FIX',
          refs: [diff],
          note: '多记的结算冲减（渠道核对）',
          contra: 'COMMISSION_REVENUE',
        }),
      ),
      0,
    );
    expect(await moneyOf(f, userId)).toEqual({ available: 2880n, frozen: 0n });
    expect(await inboxOf(f, userId)).toEqual([
      { code: MESSAGE_CODE, title: MESSAGE_TITLE, body: messageBody('¥1.2', 'RECON_FIX') },
    ]);
    await expectInAppOnly(f, userId, '调减');

    const original = await seedForm(f, {
      userId,
      direction: 'increase',
      amount: 500n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
    });
    await answer(
      await h.create({ reverses_adjust_id: original.adjust_id, note: '误调增，整笔冲回' }),
      0,
    );
    expect(await moneyOf(f, userId)).toEqual({ available: 2880n, frozen: 0n });
    const inbox = await inboxOf(f, userId);
    expect(inbox, '每张调减单恰好一条站内信').toHaveLength(2);
    expect(inbox.filter((row) => row.body === messageBody('¥5', 'RECON_FIX'))).toEqual([
      { code: MESSAGE_CODE, title: MESSAGE_TITLE, body: messageBody('¥5', 'RECON_FIX') },
    ]);
    expect(inbox.filter((row) => row.body === messageBody('¥1.2', 'RECON_FIX'))).toHaveLength(1);
    await expectInAppOnly(f, userId, '调减方向的红冲');
  });
});
