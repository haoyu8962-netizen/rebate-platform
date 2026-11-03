// B2-09i rule tests of the reading time (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutWatermark and 08 BR-WDR-18 细则「W 的取数时刻」 (D10-241, D10-248, D10-592) — against
// the injected Clock, a measured_at more than 5 minutes ahead, more than 2 hours old, or before the
// channel's latest measured_at is 20001 data.fields=[measured_at] and writes nothing; exactly 5
// minutes ahead, exactly 2 hours old and the same measured_at as the latest are accepted. The clock
// of the fixture is 10:00 +08:00. Requests go through the real admin entry (kit.ts). Top-level it()
// only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  enterBody,
  entered,
  everything,
  fieldsError,
  fixture,
  readings,
  seedWatermark,
  suite,
  withWatermarkAdmin,
} from './kit.ts';

const s = suite();

/** 2026-11-03 at this +08:00 time, as epoch milliseconds. */
const ms = (time: string) => Date.parse(`2026-11-03T${time}+08:00`);
const at = (time: string) => enterBody({ measured_at: `2026-11-03T${time}+08:00` });

it('[AC-B2-09i#6] 超前：当前 10:00，10:05 多 1 毫秒与 10:06 → 20001 data.fields=[measured_at]、什么都不写；10:04 可以，恰好 10:05 可以；再录 10:05 多 1 毫秒仍拒绝；同一时刻用 UTC 写也一样', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    await fieldsError(await h.enter(at('10:05:00.001')), ['measured_at']);
    await fieldsError(await h.enter(at('10:06:00')), ['measured_at']);
    await fieldsError(await h.enter(enterBody({ measured_at: '2026-11-03T02:05:00.001Z' })), [
      'measured_at',
    ]);
    expect(await everything(f)).toEqual(before);

    await entered(await h.enter(at('10:04:00')));
    await entered(await h.enter(at('10:05:00.000')));
    await entered(await h.enter(enterBody({ measured_at: '2026-11-03T02:05:00.000Z' })));
    expect(await readings(f)).toEqual([ms('10:04:00'), ms('10:05:00'), ms('10:05:00')]);

    const after = await everything(f);
    await fieldsError(await h.enter(at('10:05:00.001')), ['measured_at']);
    expect(await everything(f)).toEqual(after);
  });
});

it('[AC-B2-09i#7] 过旧：当前 10:00，07:59:59.999 → 20001 data.fields=[measured_at]、什么都不写；恰好 08:00 可以', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    await fieldsError(await h.enter(at('07:59:59.999')), ['measured_at']);
    await fieldsError(await h.enter(at('07:00:00')), ['measured_at']);
    expect(await everything(f)).toEqual(before);

    await entered(await h.enter(at('08:00:00.000')));
    expect(await readings(f)).toEqual([ms('08:00:00')]);
  });
});

it('[AC-B2-09i#8] 倒退：早于该通道最新一条 → 20001 data.fields=[measured_at]、什么都不写（多差 1 毫秒也拒绝）；与最新一条相同可以；录入更新的一条后，最新一条跟着变', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    await entered(await h.enter(at('09:30:00')));
    const once = await everything(f);
    await fieldsError(await h.enter(at('09:29:59.999')), ['measured_at']);
    await fieldsError(await h.enter(at('08:30:00')), ['measured_at']);
    expect(await everything(f)).toEqual(once);

    await entered(await h.enter(at('09:30:00')));
    expect(await readings(f)).toEqual([ms('09:30:00'), ms('09:30:00')]);

    await entered(await h.enter(at('09:40:00')));
    const after = await everything(f);
    await fieldsError(await h.enter(at('09:30:00')), ['measured_at']);
    await fieldsError(await h.enter(at('09:39:59.999')), ['measured_at']);
    expect(await everything(f)).toEqual(after);
  });
});

it('[AC-B2-09i#9] 倒退只和最新一条比：表里已有的（不经接口的）最新行同样算数；比最新行新但比旧行旧不存在；最新一条按 measured_at 而不是写入先后', async () => {
  const f = fixture(s);
  // 写入在后（created_at 更晚）、取数在前的一行不是最新：最新仍是 09:50。
  await seedWatermark(f, {
    availableFen: 100n,
    measuredAt: '2026-11-03T09:50:00+08:00',
    createdAt: '2026-11-03T09:51:00+08:00',
  });
  await seedWatermark(f, {
    availableFen: 100n,
    measuredAt: '2026-11-03T09:10:00+08:00',
    createdAt: '2026-11-03T09:52:00+08:00',
  });
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    await fieldsError(await h.enter(at('09:49:59.999')), ['measured_at']);
    expect(await everything(f)).toEqual(before);
    await entered(await h.enter(at('09:50:00')));
    expect(await readings(f)).toEqual([ms('09:10:00'), ms('09:50:00'), ms('09:50:00')]);
  });
});

it('[AC-B2-09i#10] 倒退按通道分别算：wechat 最新 09:50 不影响 alipay 录 09:30；alipay 最新 09:40 也不让 wechat 录 09:45 通过', async () => {
  const f = fixture(s);
  await withWatermarkAdmin(f, async (h) => {
    await entered(
      await h.enter(enterBody({ channel: 'wechat', measured_at: '2026-11-03T09:50:00+08:00' })),
    );
    await entered(await h.enter(at('09:30:00')));
    await entered(await h.enter(at('09:40:00')));
    const before = await everything(f);
    await fieldsError(
      await h.enter(enterBody({ channel: 'wechat', measured_at: '2026-11-03T09:45:00+08:00' })),
      ['measured_at'],
    );
    expect(await everything(f)).toEqual(before);
    expect(await readings(f, 'alipay')).toEqual([ms('09:30:00'), ms('09:40:00')]);
    expect(await readings(f, 'wechat')).toEqual([ms('09:50:00')]);
  });
});
