// B2-17 withdrawal holds stay (claude-independent): BR-FUND-24 ⑨ 末句「调账与红冲都不解除、不新增提现冻结
// 记录（BR-WDR-05）」, 细则「对外差错单的调账」(差错单置为 adjusted 后，它产生的 recon_diff /
// ledger_mismatch 冻结由持 risk.freeze 的账号……逐条解除) and BR-WDR-05 (冻结记录逐条解除) with §9.3 ⑬ of
// the task: across a successful execution, a 20902 refusal, a 20001 refusal and a reversal, every
// withdraw_holds row of the app is unchanged, including the ones whose source_ref is
// `recon_diff:<差错单 id>` (the source format of ../admin-recon-close/kit.ts sourceOf).
import { expect, it } from 'vitest';
import { fixture, member, suite, withAdjustAdmin } from '../admin-adjustments/kit.ts';
import { seedHold, sourceOf } from '../admin-recon-close/kit.ts';
import {
  diffConflict,
  diffRef,
  expectNowAdjusted,
  expectSentBack,
  fileOk,
  holdsOf,
  refInvalid,
  reverseOk,
  schemaReady,
  seedTicket,
  send,
  tick,
} from './kit.ts';

const s = suite();

it('[AC-B2-17#19] 调账执行（成功、20902、20001）与红冲前后，该应用的 withdraw_holds 逐行相同，含 source_ref = recon_diff:<差错单 id> 的 recon_diff / ledger_mismatch 冻结：调账既不解除也不新增冻结', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    await schemaReady(f.db);
    const userId = await member(f, { available: 1000n });
    const diff = await seedTicket(f);
    const external = await seedTicket(f, { type: 'channel_mismatch', source: 'R2' });
    for (const [reason, source] of [
      ['ledger_mismatch', diff.id],
      ['recon_diff', external.id],
    ] as const) {
      await seedHold(f, { user_id: userId, reason, source_ref: sourceOf(source) });
    }
    await seedHold(f, { user_id: userId, reason: 'manual', source_ref: null });
    const holds = await holdsOf(f);
    expect(holds).toHaveLength(3);

    const original = await fileOk(f, h, { userId, refs: [diffRef(diff)] });
    const adjusted = await expectNowAdjusted(f, diff, h.maker.id);
    expect(await holdsOf(f), '执行成功').toEqual(holds);
    tick(f);

    await diffConflict(await send(h, { userId, refs: [diffRef(diff)] }));
    expect(await holdsOf(f), '20902').toEqual(holds);
    await refInvalid(await send(h, { userId, refs: [diffRef(external)] }));
    expect(await holdsOf(f), '20001').toEqual(holds);

    await reverseOk(f, h, original.row);
    await expectSentBack(f, adjusted);
    expect(await holdsOf(f), '红冲').toEqual(holds);
  });
});
