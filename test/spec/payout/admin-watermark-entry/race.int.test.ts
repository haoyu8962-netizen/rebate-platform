// B2-09i concurrency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutWatermark — 「Entries of one channel are checked one at a time, so two racing
// requests cannot both pass on the same latest row.」 The interleaving is made with a lock, no timing:
// the first request stops right after its INSERT, its transaction open (a pause in the entry's
// database handle, kit.ts); the second is sent and must wait on a lock; then the first commits. Without
// the channel's lock the second would read a latest row without the first's and pass. The outcome must
// be one of the serial orders: the earlier reading either wrote first or gets 20001. Requests go
// through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  audits,
  enterBody,
  entered,
  fieldsError,
  fixture,
  interleaved,
  readings,
  suite,
  withWatermarkAdmin,
} from './kit.ts';

const s = suite();

const ms = (time: string) => Date.parse(`2026-11-03T${time}+08:00`);
const at = (time: string) => enterBody({ measured_at: `2026-11-03T${time}+08:00` });

it('[AC-B2-09i#31] 并发倒退：较晚的（09:40）已写入未提交时发较早的（09:30），较早的要等锁，提交后判倒退 20001 data.fields=[measured_at]；最终只有较晚的一行、一条审计（串行顺序：较晚 → 较早）', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const { first, second, waited } = await interleaved(f, h, at('09:40:00'), at('09:30:00'));
    await entered(first);
    await fieldsError(second, ['measured_at']);
    expect(waited, '较早的请求应在锁上等待').toBe(true);
    expect(await readings(f)).toEqual([ms('09:40:00')]);
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09i#32] 并发顺写：较早的（09:30）已写入未提交时发较晚的（09:40），较晚的等锁后写入；两行、两条审计，最新一条是较晚的（串行顺序：较早 → 较晚）', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const { first, second, waited } = await interleaved(f, h, at('09:30:00'), at('09:40:00'));
    await entered(first);
    await entered(second);
    expect(waited, '较晚的请求也应在锁上等待').toBe(true);
    expect(await readings(f)).toEqual([ms('09:30:00'), ms('09:40:00')]);
    expect(await audits(f, ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09i#33] 并发相同取数时间：第一个已写入未提交时发相同 measured_at 的第二个，第二个等锁后照常写入（与最新一条相同可以）', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const { first, second, waited } = await interleaved(f, h, at('09:30:00'), at('09:30:00'));
    await entered(first);
    await entered(second);
    expect(waited, '第二个请求应在锁上等待').toBe(true);
    expect(await readings(f)).toEqual([ms('09:30:00'), ms('09:30:00')]);
  });
});

it('[AC-B2-09i#34] 同时发出、不加干预：每轮较晚的都写入，较早的要么先写入、要么 20001；每轮结束最新一条都是较晚的，行数与成功数一致', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    let total = 0;
    for (const [earlier, later] of [
      ['09:00:00', '09:01:00'],
      ['09:02:00', '09:03:00'],
      ['09:04:00', '09:05:00'],
      ['09:06:00', '09:07:00'],
      ['09:08:00', '09:09:00'],
    ] as const) {
      const [a, b] = await Promise.all([h.enter(at(earlier)), h.enter(at(later))]);
      await entered(b);
      total += 1;
      if (a.statusCode === 200) {
        await entered(a);
        total += 1;
      } else {
        await fieldsError(a, ['measured_at']);
      }
      const rows = await readings(f);
      expect(rows).toHaveLength(total);
      expect(rows[rows.length - 1]).toBe(ms(later));
    }
    expect(await audits(f, ACTION)).toHaveLength(total);
  });
});
