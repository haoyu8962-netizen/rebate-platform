// B2-09i atomicity rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutWatermark — the row, the audit record and the idempotency record commit together:
// a failure of the audit record or of the row ends as 50001 and leaves no row, no audit and no
// idempotency record; the same key then succeeds once. The failure is a one-shot fault in the entry's
// database handle (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  answer,
  audits,
  enterBody,
  entered,
  everything,
  fixture,
  idempotencyRows,
  newKey,
  suite,
  watermarkRows,
  withWatermarkAdmin,
  type FaultPoint,
  type WatermarkFixture,
} from './kit.ts';

const s = suite();

async function faultCase(f: WatermarkFixture, point: FaultPoint): Promise<void> {
  await withWatermarkAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    h.fault.point = point;
    const sent = await h.enter(enterBody(), { key });
    expect(h.fault.tripped, `${point} 必须在录入事务里执行`).toBe(1);
    await answer(sent, 50001);
    expect(await everything(f)).toEqual(before);
    expect((await idempotencyRows(f)).filter((row) => row.key === key)).toEqual([]);

    const item = await entered(await h.enter(enterBody(), { key }));
    expect((await watermarkRows(f)).map((row) => row.id)).toEqual([item['watermark_id']]);
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
}

it('[AC-B2-09i#29] 写审计失败 → 50001，不留水位行，审计与幂等记录也不留；同一 key 重发即成功且只有一行一条审计', async () => {
  await faultCase(fixture(s), 'audit');
});

it('[AC-B2-09i#30] 写水位行失败 → 50001，什么都不留；同一 key 重发即成功且只有一行一条审计', async () => {
  await faultCase(fixture(s), 'watermark_insert');
});
