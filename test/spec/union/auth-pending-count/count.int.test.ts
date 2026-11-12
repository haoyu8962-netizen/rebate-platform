// B1-22zc / BR-ID-24 ①④, F-ADM-26 ①, D10-1401, SPEC_REF 62b5c99. The dashboard card
// union_auth_expiring counts the app's union accounts whose stored auth_status is expiring or
// expired — the pending rows of the real admin list GET /admin/v1/union-accounts (no paging, no
// status filter). A failed probe that is not an authorization error leaves auth_status active
// (last_probe_ok=false), so such an account is not counted. Real business-role PG, nothing mocked.
import { expect, it } from 'vitest';
import { countUnionAuthPending } from '../../../../apps/api/src/modules/union/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { listed, seedAccount, setup, type UnionAccount } from '../admin-accounts/kit.ts';

const h = useHarness();

const PENDING: readonly string[] = ['expiring', 'expired'];
const pendingRows = (items: readonly UnionAccount[]) =>
  items.filter((item) => PENDING.includes(item.auth_status));

it('[AC-B1-22zc#1][BR-ID-24] 计数等于后台联盟账号列表里 auth_status 为 expiring / expired 的行数', async () => {
  const s = await setup(h);
  // Not counted (auth_status active): a plain account, a paused one without expiry, and one whose
  // last probe failed with a non-authorization error (timeout keeps the status).
  await seedAccount(s, { platform: 'taobao', account_name: 'a-active' });
  await seedAccount(s, {
    platform: 'pdd',
    account_name: 'b-active-paused',
    status: 'paused',
    sync_start_at: null,
    auth_expires_at: null,
    last_probe_at: null,
    last_probe_ok: null,
  });
  await seedAccount(s, {
    platform: 'jd',
    account_name: 'c-active-probe-timeout',
    last_probe_ok: false,
    last_probe_error: 'synthetic-probe-timeout',
  });
  // Counted: expiring (one paused, one estimated), expired by the expiry, expired by a probe that
  // returned an authorization error before the expiry, and expired without a stored expiry.
  await seedAccount(s, {
    platform: 'taobao',
    account_name: 'd-expiring',
    auth_expires_at: new Date('2026-11-20T00:00:00.000Z'),
    auth_status: 'expiring',
    alert_stage: 'd14',
  });
  await seedAccount(s, {
    platform: 'jd',
    account_name: 'e-expiring-paused',
    status: 'paused',
    auth_expires_at: new Date('2026-11-14T00:00:00.000Z'),
    auth_expires_estimated: true,
    auth_status: 'expiring',
    alert_stage: 'd1',
  });
  await seedAccount(s, {
    platform: 'taobao',
    account_name: 'f-expired',
    auth_expires_at: new Date('2026-10-01T00:00:00.000Z'),
    auth_status: 'expired',
    alert_stage: 'expired',
  });
  await seedAccount(s, {
    platform: 'jd',
    account_name: 'g-expired-probe',
    auth_status: 'expired',
    alert_stage: 'expired',
    last_probe_ok: false,
    last_probe_error: 'synthetic-auth-invalid',
  });
  await seedAccount(s, {
    platform: 'pdd',
    account_name: 'h-expired-no-expiry',
    auth_expires_at: null,
    auth_status: 'expired',
    alert_stage: 'expired',
    last_probe_ok: false,
    last_probe_error: 'synthetic-auth-invalid',
  });

  const count = await countUnionAuthPending(h.db, s.appId);
  const items = await listed(s);
  expect(items).toHaveLength(8);
  // By hand: d-expiring, e-expiring-paused, f-expired, g-expired-probe, h-expired-no-expiry = 5.
  expect(
    pendingRows(items)
      .map((item) => item.account_name)
      .sort(),
  ).toEqual([
    'd-expiring',
    'e-expiring-paused',
    'f-expired',
    'g-expired-probe',
    'h-expired-no-expiry',
  ]);
  expect(count).toBe(pendingRows(items).length);
  expect(count).toBe(5);
});

it('[AC-B1-22zc#2][BR-ID-24] 只数本 app：别的 app 的 expiring / expired 账号不计入', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await seedAccount(s, { platform: 'taobao', account_name: 'mine-active' });
  await seedAccount(s, { platform: 'jd', account_name: 'mine-expiring', auth_status: 'expiring' });
  await seedAccount(other, {
    platform: 'taobao',
    account_name: 'x-expiring',
    auth_status: 'expiring',
  });
  await seedAccount(other, { platform: 'jd', account_name: 'x-expired', auth_status: 'expired' });
  await seedAccount(other, {
    platform: 'pdd',
    account_name: 'x-expired-paused',
    status: 'paused',
    auth_expires_at: null,
    auth_status: 'expired',
  });
  await seedAccount(other, { platform: 'pdd', account_name: 'x-active' });

  // By hand: this app 1 (mine-expiring); the other app 3 (x-expiring, x-expired, x-expired-paused).
  const mine = await countUnionAuthPending(h.db, s.appId);
  expect(mine).toBe(1);
  expect(mine).toBe(pendingRows(await listed(s)).length);
  const theirs = await countUnionAuthPending(h.db, other.appId);
  expect(theirs).toBe(3);
  expect(theirs).toBe(pendingRows(await listed(other)).length);
});

it('[AC-B1-22zc#3][BR-ID-24] 本 app 没有联盟账号或全是 active（含探测非授权类失败）时计数为 0', async () => {
  const empty = await setup(h);
  // Another app's pending accounts exist, so 0 is not an empty table.
  const busy = await setup(h);
  await seedAccount(busy, { platform: 'taobao', auth_status: 'expired' });
  await seedAccount(busy, { platform: 'jd', auth_status: 'expiring' });
  expect(await countUnionAuthPending(h.db, empty.appId)).toBe(0);
  expect(await listed(empty)).toEqual([]);

  const allActive = await setup(h);
  await seedAccount(allActive, { platform: 'taobao' });
  await seedAccount(allActive, {
    platform: 'jd',
    last_probe_ok: false,
    last_probe_error: 'synthetic-probe-rate-limited',
  });
  await seedAccount(allActive, {
    platform: 'pdd',
    status: 'paused',
    auth_expires_at: null,
    last_probe_ok: null,
  });
  expect(await countUnionAuthPending(h.db, allActive.appId)).toBe(0);
  expect(pendingRows(await listed(allActive))).toEqual([]);
});
