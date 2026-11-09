// B1-06zl rule-test kit (BR-PROD-10 转链开关; BR-TEXT-14 50301 行与 data.reason; D10-1138 / D10-1139 选 A).
// convert.enabled.<platform> off → 50301 whose data is exactly { platform, reason }, reason from
// convert.off_reason.<platform> (absent → not_launched): the value GET /v1/config's
// features.platform_status gives the same platform from the same config_items rows (同源).
// Only synthetic values; no test lives here.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { purchaseStatus } from '../../../../apps/api/src/modules/content/domain/client-config.ts';

export type Platform = 'taobao' | 'jd' | 'pdd';
export type Reason = 'maintenance' | 'not_launched';
export const PLATFORMS: readonly Platform[] = ['taobao', 'jd', 'pdd'];

/**
 * [label, the reason 50301 must carry, the stored convert.off_reason.<platform> (undefined: no
 * row)]. The absent row comes first: the case that differs from every answer before this task.
 * A value outside the enum is read as features.platform_status reads it (not maintenance →
 * not_launched); the contract's data.reason has only the two values.
 */
export const OFF_REASONS: readonly (readonly [string, Reason, string | undefined])[] = [
  ['未配置', 'not_launched', undefined],
  ['maintenance', 'maintenance', 'maintenance'],
  ['not_launched', 'not_launched', 'not_launched'],
  ['不认识的取值', 'not_launched', 'synthetic_unknown_reason'],
];

/** Upserts one config_items row of the tenant (JSON text, as the admin write stores it). */
export async function storeConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: boolean | string,
): Promise<void> {
  const json = JSON.stringify(value);
  await db
    .insertInto('config_items')
    .values({ app_id: appId, key, value: json, updated_by: 'synthetic-b1-06zl' })
    .onConflict((conflict) => conflict.columns(['app_id', 'key']).doUpdateSet({ value: json }))
    .execute();
}

/** convert.enabled.<platform> and convert.off_reason.<platform>; undefined writes no row. */
export async function storeSwitch(
  db: Kysely<DB>,
  appId: string,
  platform: Platform,
  enabled: boolean | undefined,
  offReason: string | undefined,
): Promise<void> {
  if (enabled !== undefined) await storeConfig(db, appId, `convert.enabled.${platform}`, enabled);
  if (offReason !== undefined) {
    await storeConfig(db, appId, `convert.off_reason.${platform}`, offReason);
  }
}

/**
 * The 50301 data of a switched-off platform: exactly { platform, reason }, and the reason is the
 * one features.platform_status derives from the same stored values.
 */
export function expectPausedData(
  data: unknown,
  platform: Platform,
  enabled: boolean | undefined,
  offReason: string | undefined,
  reason: Reason,
): void {
  expect(purchaseStatus(enabled, offReason), 'features.platform_status（同源）').toBe(reason);
  expect(data).toStrictEqual({ platform, reason });
  expect(Object.keys(data as object).sort()).toEqual(['platform', 'reason']);
}

/** A refusal that is not the switch: no data.reason and no data.platform of the switch. */
export function expectNoSwitchData(data: unknown): void {
  expect(data ?? {}).not.toHaveProperty('reason');
  expect(data ?? {}).not.toHaveProperty('platform');
}
