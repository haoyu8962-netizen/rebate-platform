// B1-02zzz: the display number comes from the same account as the authenticated GET /v1/me.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FIELD_CRYPTO, type FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import { openKit, closeKit, fixture, me, type Kit, type Fixture } from '../me/http-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

async function bind(f: Fixture, number: string) {
  const crypto = kit.app.get<FieldCrypto>(FIELD_CRYPTO);
  await f.db
    .updateTable('users')
    .set({
      phone_hmac: crypto.blindIndex(number, 'users.phone'),
      phone_cipher: Buffer.from(crypto.encrypt(number, 'users.phone'), 'utf8'),
    })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.uid)
    .execute();
}

it.each(['full', 'deletion_only'] as const)(
  '[AC-B1-02zzz#15] %s 会话显示本人手机的前三后四位，不泄露原号或密文',
  async (scope) => {
    const f = await fixture(kit);
    await bind(f, '13800138000');
    const response = await f.get(scope);
    expect(me(kit, response)).toMatchObject({
      user_id: f.uid,
      phone_bound: true,
      masked_phone: '138****8000',
    });
    const body = response.json<{ data: Record<string, unknown> }>();
    for (const key of ['phone', 'phone_cipher', 'phone_hmac']) {
      expect(body.data).not.toHaveProperty(key);
    }
    expect(JSON.stringify(body)).not.toContain('13800138000');
    expect(kit.lines.join('')).not.toContain('13800138000');
  },
);

it('[AC-B1-02zzz#16] 未绑定手机号明确返回 masked_phone=null，不省略字段', async () => {
  const f = await fixture(kit);
  expect(me(kit, await f.get())).toMatchObject({ phone_bound: false, masked_phone: null });
});

it('[AC-B1-02zzz#17] 同 app 不同账号、不同 app 的手机号展示互不串号', async () => {
  const a = await fixture(kit);
  const b = await fixture(kit, { appId: a.appId });
  const c = await fixture(kit);
  await bind(a, '13800138000');
  await bind(b, '13900139001');
  await bind(c, '13700137002');
  for (const [f, masked] of [
    [a, '138****8000'],
    [b, '139****9001'],
    [c, '137****7002'],
  ] as const) {
    expect(me(kit, await f.get())).toMatchObject({ user_id: f.uid, masked_phone: masked });
  }
});

it('[AC-B1-02zzz#18] 同一会话换绑后 GET /v1/me 显示新绑定手机', async () => {
  const f = await fixture(kit);
  await bind(f, '13800138000');
  expect(me(kit, await f.get())).toMatchObject({ masked_phone: '138****8000' });
  await bind(f, '13900139001');
  expect(me(kit, await f.get())).toMatchObject({ phone_bound: true, masked_phone: '139****9001' });
});
