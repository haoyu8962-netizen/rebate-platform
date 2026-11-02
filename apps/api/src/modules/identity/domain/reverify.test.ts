import { expect, it } from 'vitest';
import {
  MANUAL_REQUIREMENT,
  REVERIFY_FAIL_LIMIT,
  failuresOn,
  isDormantLogin,
  reverifyRequirement,
  trustedIdentitiesOf,
} from './reverify.ts';

const NOW = new Date('2026-10-08T02:00:00.000Z');
const DAY = 86_400_000;
const due = {
  days: 180,
  now: NOW,
  lastActiveAt: new Date(NOW.getTime() - 180 * DAY),
  lastDeviceHash: 'a',
  deviceHash: 'b',
  flaggedAt: null,
};

it('[B1-02zp] 到期且设备不同才打标，边界含等于', () => {
  expect(isDormantLogin(due)).toBe(true);
  const short = new Date(NOW.getTime() - 180 * DAY + 1000);
  expect(isDormantLogin({ ...due, lastActiveAt: short })).toBe(false);
  expect(isDormantLogin({ ...due, deviceHash: 'a' })).toBe(false);
});

it('[B1-02zp] 开关关闭、已有标记或缺旧值都不打标', () => {
  expect(isDormantLogin({ ...due, days: 0 })).toBe(false);
  expect(isDormantLogin({ ...due, flaggedAt: NOW })).toBe(false);
  expect(isDormantLogin({ ...due, lastActiveAt: null })).toBe(false);
  expect(isDormantLogin({ ...due, lastDeviceHash: null })).toBe(false);
  expect(isDormantLogin({ ...due, deviceHash: null })).toBe(false);
});

it('[B1-02zp] 读不出的快照不信任任何身份，未知 provider 被去掉', () => {
  expect(trustedIdentitiesOf(null)).toEqual({ realname: false, providers: [] });
  expect(trustedIdentitiesOf({ realname: true, providers: ['apple', 'x'] })).toEqual({
    realname: true,
    providers: ['apple'],
  });
});

it('[B1-02zp] 只算当天的失败数', () => {
  expect(failuresOn('2026-10-08', '2026-10-08', 3)).toBe(3);
  expect(failuresOn('2026-10-08', '2026-10-07', 3)).toBe(0);
  expect(failuresOn('2026-10-08', null, 3)).toBe(0);
});

it('[B1-02zp] 方式按优先级：实名、第三方、人工，满上限转人工', () => {
  const trusted = { realname: true, providers: ['wechat'] } as const;
  expect(reverifyRequirement(trusted, 1)).toEqual({
    method: 'id_number',
    providers: [],
    fail_limit: REVERIFY_FAIL_LIMIT,
    fail_remaining: REVERIFY_FAIL_LIMIT - 1,
  });
  expect(reverifyRequirement({ realname: false, providers: ['wechat'] }, 0)).toMatchObject({
    method: 'oauth',
    providers: ['wechat'],
  });
  expect(reverifyRequirement({ realname: false, providers: [] }, 0)).toEqual(MANUAL_REQUIREMENT);
  expect(reverifyRequirement(trusted, REVERIFY_FAIL_LIMIT)).toEqual(MANUAL_REQUIREMENT);
});
