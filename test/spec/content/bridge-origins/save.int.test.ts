import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, signedIn, useHarness } from '../../admin/auth/kit.ts';
import { seed } from '../../admin/accounts/kit.ts';
import {
  hasRoute,
  OPERATIONS,
  ROUTES,
  update,
  rejected,
  success,
  snapshot,
  stepUp,
  type Item,
} from '../config-items/kit.ts';
import { appId, REQUIRED, seedConfig, headers } from '../config/kit.ts';
import { verified } from './jws-kit.ts';

const h = useHarness();
let directory: string;
let pair: ReturnType<typeof generatePair>;
function generatePair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}
beforeAll(() => {
  const base = fileURLToPath(new URL('../../../../.tmp/bridge-save/', import.meta.url));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, 'case-'));
  pair = generatePair();
  const file = join(directory, 'synthetic.pem');
  writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  h.env['CONFIG_SIGN_KEY_FILE'] = file;
  h.env['CONFIG_SIGN_KEY_ID'] = 'save-fixture';
});
afterAll(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

async function context() {
  const f = await fixture(h);
  for (const op of OPERATIONS) expect(hasRoute(f.app, op), ROUTES[op].path).toBe(true);
  const id = appId();
  const actor = await seed(h, id, { isSuper: true });
  const session = await signedIn(f, actor);
  const admin = { ...f, appId: id, actor, token: session.admin_token };
  await seedConfig(h.db, admin.appId, REQUIRED);
  const api = await fixture(h, { entry: 'api' });
  async function read() {
    const response = await api.app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: headers(admin.appId),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ code: number; data: { bridge_origins: { jws: string } } }>();
    expect(body.code).toBe(0);
    return {
      signed: body.data.bridge_origins,
      payload: verified(body.data.bridge_origins, pair.publicKey, 'save-fixture'),
    };
  }
  return { admin, api, read };
}

const invalid: unknown[] = [
  null,
  [],
  'text',
  {},
  { origins: 'https://h5.example.test' },
  { origins: [] },
  { origins: [42] },
  { origins: ['http://h5.example.test'] },
  { origins: ['https://h5.example.test/path'] },
  { origins: ['https://h5.example.test/'] },
  { origins: ['https://h5.example.test?query=1'] },
  { origins: ['https://h5.example.test#fragment'] },
  { origins: ['https://*.example.test'] },
  { origins: ['https://H5.example.test'] },
  { origins: ['https://other.example.test'] },
  { origins: ['https://h5.example.test', 'https://bad.example.test/path'] },
  { origins: ['https://h5.example.test', 'https://name@other.example.test'] },
];
it.each(invalid.map((value) => ({ value })))(
  '[AC-F1-02zzzb#16] 后台拒绝非法 bridge_origins $value，20001 fields=value 且不落库',
  async ({ value }) => {
    const f = await context();
    const before = await f.read();
    expect(before.payload.origins).toEqual(['https://h5.example.test']);
    const extra = { stepUp: await stepUp(f.admin) };
    const rows = await snapshot(h, f.admin.appId);
    await rejected(
      await update(f.admin, 'bridge_origins', { value, expected_version: 0 }, extra),
      'update',
      20001,
      { fields: ['value'] },
    );
    expect(await snapshot(h, f.admin.appId)).toEqual(rows);
    expect((await f.read()).signed).toEqual(before.signed);
  },
);

it('[AC-F1-02zzzb#17] 后台合格保存后下一次读取即变更白名单与版本，默认缓存失效', async () => {
  const f = await context();
  const before = await f.read();
  const value = { origins: ['https://h5.example.test', 'https://bridge.example.test:8443'] };
  const item = await success<Item>(
    await update(
      f.admin,
      'bridge_origins',
      { value, expected_version: 0 },
      { stepUp: await stepUp(f.admin) },
    ),
    'update',
  );
  expect(item.value).toEqual(value);
  expect(item.version).toBe(1);
  const after = await f.read();
  expect(after.payload).toMatchObject({
    app_id: f.admin.appId,
    env: 'test',
    version: item.version,
    origins: value.origins,
  });
  expect(after.payload.version).toBeGreaterThanOrEqual(before.payload.version);
  expect(after.signed).not.toEqual(before.signed);
  const updated = { origins: ['https://h5.example.test', 'https://new.example.test'] };
  const second = await success<Item>(
    await update(
      f.admin,
      'bridge_origins',
      { value: updated, expected_version: item.version },
      { stepUp: await stepUp(f.admin) },
    ),
    'update',
  );
  const next = await f.read();
  expect(next.payload).toMatchObject({ version: second.version, origins: updated.origins });
  expect(second.version).toBeGreaterThan(item.version);
  expect(next.signed).not.toEqual(after.signed);
  expect(f.api.lines.join('\n')).not.toContain(after.signed.jws);
  expect([...f.api.lines, ...f.admin.lines].join('\n')).not.toContain(
    '-----BEGIN PRIVATE KEY-----',
  );
});
