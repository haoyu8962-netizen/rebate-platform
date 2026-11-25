// B1-22ze: the pure parts of the persistent backend alert (./alert-log.ts).
// 错实现下怎么红：
// - alert_key 不含到期时刻或节点（重新授权后同节点撞键不再记）、expired 不带进入失效时刻（恢复后再次
//   失效撞键）、非 expired 也带时刻（同节点重投不撞键、重复记录）：第一条红。
// - 载荷带了告警字段 / 手机号，或少了 alert_id：第二条红。
// - 日志行字段或级别与原来不同（expiring 非 warn、expired 非 error、漏 cause、漏 phones_missing、
//   有手机号也打 phones_missing）：第三、四条红。
import { expect, it } from 'vitest';
import {
  alertLogLines,
  alertLogPayload,
  alertLogSingletonKey,
  authAlertKey,
  type AuthAlertRecord,
} from './alert-log.ts';

const EXPIRES = new Date('2026-11-23T09:29:00.000Z');
const ENTERED = new Date('2026-11-20T01:00:00.000Z');

function record(overrides: Partial<AuthAlertRecord> = {}): AuthAlertRecord {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    app_id: 'unit-app',
    union_account_id: '00000000-0000-4000-8000-000000000001',
    platform: 'taobao',
    stage: 'h6',
    alert_key: 'k',
    auth_expires_at: EXPIRES,
    entered_at: null,
    phones_configured: true,
    cause: null,
    created_at: ENTERED,
    ...overrides,
  };
}

it('[B1-22ze][BR-ID-24] alert_key：d / h 节点为「到期时刻:节点」，expired 另加进入失效时刻，无到期时刻写 none', () => {
  expect(authAlertKey({ stage: 'd14', authExpiresAt: EXPIRES, expired: null })).toBe(
    `${EXPIRES.toISOString()}:d14`,
  );
  expect(authAlertKey({ stage: 'h6', authExpiresAt: EXPIRES, expired: null })).toBe(
    `${EXPIRES.toISOString()}:h6`,
  );
  const expired = { cause: 'probe' as const, enteredAt: ENTERED };
  expect(authAlertKey({ stage: 'expired', authExpiresAt: EXPIRES, expired })).toBe(
    `${EXPIRES.toISOString()}:expired:${ENTERED.toISOString()}`,
  );
  expect(authAlertKey({ stage: 'expired', authExpiresAt: null, expired })).toBe(
    `none:expired:${ENTERED.toISOString()}`,
  );
  // Another expiry or another entry is another key.
  const later = new Date(EXPIRES.getTime() + 86_400_000);
  expect(authAlertKey({ stage: 'h6', authExpiresAt: later, expired: null })).not.toBe(
    authAlertKey({ stage: 'h6', authExpiresAt: EXPIRES, expired: null }),
  );
});

it('[B1-22ze][BR-ID-24] alert_log 载荷只有 app_id、union_account_id、alert_id；singletonKey 含告警行 id', () => {
  const row = record();
  expect(alertLogPayload(row)).toEqual({
    app_id: row.app_id,
    union_account_id: row.union_account_id,
    alert_id: row.id,
  });
  expect(alertLogSingletonKey(row.id)).toContain(row.id);
  expect(alertLogSingletonKey(row.id)).not.toBe(alertLogSingletonKey('other'));
});

it('[B1-22ze][BR-ID-24] 即将到期的日志：有手机号只一行 warn union_auth_expiring，字段取自记录', () => {
  expect(alertLogLines(record())).toEqual([
    {
      level: 'warn',
      msg: 'union_auth_expiring',
      fields: {
        app_id: 'unit-app',
        platform: 'taobao',
        union_account_id: '00000000-0000-4000-8000-000000000001',
        stage: 'h6',
        auth_expires_at: EXPIRES.toISOString(),
        phones_configured: true,
      },
    },
  ]);
});

it('[B1-22ze][BR-ID-24] 失效的日志：无手机号先 warn phones_missing，再 error union_auth_expired 带 cause', () => {
  const lines = alertLogLines(
    record({
      stage: 'expired',
      cause: 'time',
      entered_at: ENTERED,
      auth_expires_at: null,
      phones_configured: false,
    }),
  );
  expect(lines.map((l) => [l.level, l.msg])).toEqual([
    ['warn', 'union_auth_alert_phones_missing'],
    ['error', 'union_auth_expired'],
  ]);
  expect(lines[0]!.fields).toEqual({
    app_id: 'unit-app',
    platform: 'taobao',
    union_account_id: '00000000-0000-4000-8000-000000000001',
    stage: 'expired',
  });
  expect(lines[1]!.fields).toEqual({
    app_id: 'unit-app',
    platform: 'taobao',
    union_account_id: '00000000-0000-4000-8000-000000000001',
    stage: 'expired',
    auth_expires_at: null,
    phones_configured: false,
    cause: 'time',
  });
});
