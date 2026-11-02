// B1-02zw · after the clearing the re-verification judgement lets the account through (task §9 #7;
// BR-WDR-01 细则「清除标记只走人工」, BR-WDR-03 ③b; 10010). The member side is the B1-02zq kit over the
// real api entry; the save is the real PATCH on an admin entry over the same database, Redis and
// field keyring (the files buildApp left in kit.dir).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { hashAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { ORIGIN, type Harness } from '../../admin/auth/kit.ts';
import { REASON, edit, testPhone } from '../admin-profile/kit.ts';
import { MANUAL, RULES, WITHDRAW, answer, gates, refused } from '../reverify-gates/kit.ts';
import { NOT_REQUIRED, closeKit, openKit, statusOf, type Kit } from '../reverify/kit.ts';
import { scene } from './kit.ts';

let kit: Kit;
let h: Harness;

beforeAll(async () => {
  kit = await openKit();
  const password = randomBytes(24).toString('base64url');
  const appKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  h = {
    db: kit.suite.db.withSchema('app'),
    redis: kit.suite.server,
    fields: kit.crypto,
    env: {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: join(kit.dir, 'master.hex'),
      FIELD_KEYRING_FILE: join(kit.dir, 'keyring.json'),
      ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1,192.0.2.0/24,2001:db8::/32',
      ADMIN_CORS_ORIGIN: ORIGIN,
      JWT_KEY_ID: 'b1-02zw-app',
      JWT_PRIVATE_KEY_PEM: appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    password,
    passwordHash: await hashAdminPassword(password),
    appKey,
    apps: [],
  };
}, 180_000);
afterEach(async () => {
  for (const app of h.apps.splice(0)) await app.close();
});
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-02zw#27] 改号成功后加验判定放行：同一账号提现从 10010 变成受理，提现规则与 GET /v1/me/reverify 一致，没加验过的设备也一样', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.bind(m.uid, 'wechat');
  await f.flag(m.uid, { realname: false, providers: [] });
  refused(kit, WITHDRAW, 'post', await f.on(m).withdraw(), MANUAL);

  const s = await scene(h, { appId: f.appId });
  const response = await edit(s, m.uid, { phone: testPhone(), reason: REASON });
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);

  expect(await f.state(m.uid)).toMatchObject({
    reverify_flagged_at: null,
    reverify_trusted: null,
    reverify_fail_count: 0,
  });
  // The phone change revoked every session: these are new ones of the same member.
  const other = await f.device();
  const rules = answer(kit, RULES, 'get', await f.on(m, other).rules(), 0).data;
  expect(rules?.['block_code'] ?? null).toBeNull();
  expect(statusOf(kit, await f.client(m.uid, m.device).status())).toEqual(NOT_REQUIRED);
  expect(answer(kit, WITHDRAW, 'post', await f.on(m).withdraw(), 0).data).toMatchObject({
    status: 'PENDING_REVIEW',
    amount_fen: 1000,
  });
});

it('[AC-B1-02zw#28] 只改昵称不放行：提现仍 10010，真改号之后才受理', async () => {
  const f = await gates(kit);
  const m = await f.member();
  await f.flag(m.uid, { realname: false, providers: [] });
  const s = await scene(h, { appId: f.appId });
  const renamed = await edit(s, m.uid, { nickname: '小狸', reason: REASON });
  expect(renamed.statusCode, JSON.stringify(renamed.json())).toBe(200);
  refused(kit, WITHDRAW, 'post', await f.on(m).withdraw(), MANUAL);

  const changed = await edit(s, m.uid, { phone: testPhone(), reason: REASON });
  expect(changed.statusCode, JSON.stringify(changed.json())).toBe(200);
  expect(answer(kit, WITHDRAW, 'post', await f.on(m).withdraw(), 0).data).toMatchObject({
    status: 'PENDING_REVIEW',
  });
});
