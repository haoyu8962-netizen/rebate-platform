// B2-04zs rule tests, W 的录入人 (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// AdminFundLedgerWatermark; 编排裁定 D10-589 — payout_watermarks.entered_by is free text. When it is the
// id of an admin of this app, entered_by is that id and entered_by_name the account's current name
// (display_name, else the username); any other value (finance:synthetic, a UUID that is no admin, an
// admin of another app) gives null in both, and never an error from reading it as a UUID. Transitional:
// the W entry API does not exist yet (编排已知). Rows are seeded by INSERT (kit.ts). Top-level it() only
// (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  byNobody,
  fixture,
  overview,
  seedAdmin,
  seedWatermark,
  suite,
  watermarkOf,
  withFundAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zs#30] entered_by 是本 app 管理员的 UUID：给 id 和 display_name；改名后显示当前姓名', async () => {
  const f = fixture(s);
  const admin = await seedAdmin(f, { displayName: '财务小周' });
  const measuredAt = await seedWatermark(f, { fen: 3_000_000n, enteredBy: admin.id });
  await withFundAdmin(f, async (h) => {
    expect(watermarkOf(await overview(await h.read()))).toEqual({
      available_fen: 3_000_000,
      measured_at: measuredAt,
      entered_by: admin.id,
      entered_by_name: '财务小周',
    });

    await sql`UPDATE app.admin_users SET display_name = '财务小吴'
      WHERE app_id = ${f.appId} AND id = ${admin.id}`.execute(f.db);
    const renamed = watermarkOf(await overview(await h.read()));
    expect(renamed?.entered_by).toBe(admin.id);
    expect(renamed?.entered_by_name).toBe('财务小吴');
  });
});

it('[AC-B2-04zs#31] 管理员没有 display_name：entered_by_name 用登录名', async () => {
  const f = fixture(s);
  const admin = await seedAdmin(f);
  const measuredAt = await seedWatermark(f, { fen: 3_000_000n, enteredBy: admin.id });
  await withFundAdmin(f, async (h) => {
    expect(watermarkOf(await overview(await h.read()))).toEqual({
      available_fen: 3_000_000,
      measured_at: measuredAt,
      entered_by: admin.id,
      entered_by_name: admin.loginName,
    });
  });
});

it('[AC-B2-04zs#32] entered_by 不是 UUID（finance:synthetic）：两个字段都是 null，读取照常 200，W 照常返回', async () => {
  const f = fixture(s);
  const measuredAt = await seedWatermark(f, { fen: 3_000_000n, enteredBy: 'finance:synthetic' });
  await withFundAdmin(f, async (h) => {
    expect(watermarkOf(await overview(await h.read()))).toEqual(byNobody(3_000_000, measuredAt));
  });
});

it('[AC-B2-04zs#33] entered_by 是 UUID 但不是管理员：两个字段都是 null，不回显原值', async () => {
  const f = fixture(s);
  const measuredAt = await seedWatermark(f, { fen: 3_000_000n, enteredBy: randomUUID() });
  await withFundAdmin(f, async (h) => {
    expect(watermarkOf(await overview(await h.read()))).toEqual(byNobody(3_000_000, measuredAt));
  });
});

it('[AC-B2-04zs#34] entered_by 是别的 app 的管理员：两个字段都是 null，不串别的 app 的姓名', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const stranger = await seedAdmin(f, { displayName: '别的应用的人', appId: other.appId });
  const measuredAt = await seedWatermark(f, { fen: 3_000_000n, enteredBy: stranger.id });
  await withFundAdmin(f, async (h) => {
    expect(watermarkOf(await overview(await h.read()))).toEqual(byNobody(3_000_000, measuredAt));
  });
});
