// B2-09m gate rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid "Not checked, because they gate EXECUTE and not W8": payout.enabled,
// payout.queue_paused, the channel switches and the watermark (BR-WDR-18). A withdrawal paid outside the
// channel still counts against W: watermark.committed adds it when paid_at > t_W, so paid_at exactly t_W
// does not count. Each case has a control through the real EXECUTE route that shows the gate is really
// shut. Requests go through the real admin entry (manual-paid-harness.ts). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import { createWatermarkReader } from '../../../../apps/api/src/modules/payout/application/watermark.ts';
import {
  HOUR,
  MINUTE,
  NET,
  PLENTY,
  answer,
  approved,
  asPaidManual,
  entryOf,
  expectItems,
  fixture,
  ofNet,
  paid,
  payee,
  rowOf,
  seedW,
  setSwitch,
  suite,
  withOffset,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#13] 不走的门：payout.enabled 关、payout.queue_paused 开、通道开关关、通道暂停开、没有 W，都不挡补录；同样的单走 EXECUTE 被拒', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    await setSwitch(f, 'payout.enabled', false);
    await setSwitch(f, 'payout.queue_paused', true);
    await setSwitch(f, 'payout.channel_enabled.alipay', false);
    await setSwitch(f, 'payout.channel_enabled.bank_card', false);
    await setSwitch(f, 'payout.channel_paused.alipay', true);
    const who = await payee(f, h);
    const alipay = await approved(f, h, who);
    const bank = await approved(f, h, who, { method: 'bank_card' });
    const control = await approved(f, h, who);
    const alipayEntry = entryOf(f, alipay);
    const bankEntry = entryOf(f, bank);

    await expectItems(await h.manualPaid([alipayEntry, bankEntry]), [
      paid(alipay.id),
      paid(bank.id),
    ]);

    expect(await rowOf(f, alipay)).toEqual(asPaidManual(f, alipay, alipayEntry, h.entry.id));
    expect(await rowOf(f, bank)).toEqual(asPaidManual(f, bank, bankEntry, h.entry.id));
    await answer(await h.execute([control.id]), 0, {
      outcome: 'rejected',
      batch_id: null,
      reason: 'payout_disabled',
      channel: null,
      paying: [],
      left: [],
    });
    expect(await rowOf(f, control)).toEqual(control);
  });
});

it('[AC-B2-09m#14] W 过期或不足都不挡补录（BR-WDR-18 只管 EXECUTE）：W 是 48 小时前的、W 只有 1 分，都 paid；同样的单走 EXECUTE 被拒', async () => {
  for (const ageMs of [48 * HOUR, 10 * MINUTE]) {
    const f = fixture(s);
    await withManualAdmin(f, async (h) => {
      const who = await payee(f, h);
      const w = await approved(f, h, who);
      const control = await approved(f, h, who);
      await seedW(f, { fen: 1n, ageMs });
      const entry = entryOf(f, w);

      await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

      expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
      const refused = await answer(await h.execute([control.id]), 0);
      expect(refused.data, String(ageMs)).toMatchObject({ outcome: 'rejected', channel: 'alipay' });
      expect(await rowOf(f, control)).toEqual(control);
    });
  }
});

it('[AC-B2-09m#15] 补录后 watermark.committed 的已付按 paid_at > t_W 计入：paid_at 恰好等于 t_W 的 20,011 不计，多 1 毫秒的 12,347 计入；PAYING 不受影响', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const atW = await approved(f, h, who, ofNet(20_011n));
    const afterW = await approved(f, h, who);
    const tW = await seedW(f, { fen: PLENTY, ageMs: 10 * MINUTE });

    await expectItems(
      await h.manualPaid([
        entryOf(f, atW, { paid_at: withOffset(new Date(tW)) }),
        entryOf(f, afterW, { paid_at: withOffset(new Date(tW + 1)) }),
      ]),
      [paid(atW.id), paid(afterW.id)],
    );

    const committed = await f.db.transaction().execute((trx) =>
      createWatermarkReader().committed(trx, {
        appId: f.appId,
        channel: 'alipay',
        since: new Date(tW),
      }),
    );
    expect(committed).toEqual({ payingNetFen: 0n, paidSinceNetFen: NET });
  });
});
