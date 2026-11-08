// B1-02zzi: POST /v1/devices reads the invalid-hash list from config device.invalid_hashes of the
// request's app (08 BR-ID-09 细则「设备标识的无效值」: format mismatch or a hash on the list →
// 20001 with data.fields=[device_hash], no device_id; the list's seeds come with specs and
// operations may add to it). D10-1034 ②: the list is the seeds united with the configured value
// (a seed can never be removed); a missing, malformed or unreadable value means the seeds alone,
// never a looser list. A change of the row is seen by the next registration (no restart).
// Each test uses its own fresh app ids, so no row of another test or of the seeded defaults
// is involved.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appId as newAppId } from '../../risk/rate-limit/kit.ts';
import { closeSuite, issued, openSuite, refused, setConfig, type Suite } from './kit.ts';
import { freshHash, SEEDS } from './seeds.ts';

let suite: Suite | undefined;

beforeAll(async () => {
  suite = await openSuite();
});

afterAll(async () => {
  await closeSuite(suite);
});

function current(): Suite {
  expect(suite, '前置条件：应用已启动').toBeDefined();
  expect(SEEDS.length, '前置条件：specs 给出了种子').toBeGreaterThan(0);
  return suite!;
}

async function seedsRefused(s: Suite, appId: string, label: string): Promise<void> {
  for (const seed of SEEDS) await refused(s, appId, seed, `${label}：种子 ${seed}`);
}

it('[AC-B1-02zzi#1][BR-ID-09 细则「设备标识的无效值」] 运营在种子之后追加哈希 H：用 H 注册 20001 [device_hash] 不签发不落库，种子各项照样 20001，清单外的合法哈希照常签发', async () => {
  const s = current();
  const app = newAppId();
  const added = freshHash();
  await setConfig(s, app, [...SEEDS, added]);
  await refused(s, app, added, '追加项 H');
  await seedsRefused(s, app, '种子加 H');
  await issued(s, app, freshHash(), '清单外的合法哈希');
});

it('[AC-B1-02zzi#2][BR-ID-09 细则；D10-1034 ②] 删不掉种子：配置只写 [H] 时种子各项与 H 都 20001（并集，不是替换）；配置写成空数组时种子照样 20001', async () => {
  const s = current();
  const onlyAdded = newAppId();
  const added = freshHash();
  await setConfig(s, onlyAdded, [added]);
  await refused(s, onlyAdded, added, '只写 [H]：H');
  await seedsRefused(s, onlyAdded, '只写 [H]');
  await issued(s, onlyAdded, freshHash(), '只写 [H]：清单外的合法哈希');

  const emptied = newAppId();
  await setConfig(s, emptied, []);
  await seedsRefused(s, emptied, '空数组');
  await issued(s, emptied, freshHash(), '空数组：清单外的合法哈希');
});

it('[AC-B1-02zzi#3][BR-ID-09 细则；D10-1034 ②] 本 app 没有配置行时只用种子（种子 20001、H 照常签发）；运营补上 [H] 后下一次注册 H 即 20001', async () => {
  const s = current();
  const app = newAppId();
  const added = freshHash();
  await seedsRefused(s, app, '无配置行');
  await issued(s, app, added, '无配置行：H 不在清单');
  await setConfig(s, app, [added]);
  await refused(s, app, added, '补上 [H] 后：H');
  await seedsRefused(s, app, '补上 [H] 后');
  await issued(s, app, freshHash(), '补上 [H] 后：清单外的合法哈希');
});

it('[AC-B1-02zzi#4][BR-ID-09 细则；D10-1034 ②] 数组里混有非法项（非字符串、对象、嵌套数组、大写 hex、带空白、长度不符、非 hex）：非法项忽略且不被改写后使用，合法项 H 照用，种子照用', async () => {
  const s = current();
  const app = newAppId();
  const added = freshHash();
  const inObject = freshHash();
  const nested = freshHash();
  const upper = freshHash();
  const padded = freshHash();
  await setConfig(s, app, [
    123,
    null,
    true,
    { device_hash: inObject },
    [nested],
    upper.toUpperCase(),
    ` ${padded} `,
    freshHash().slice(1),
    `${freshHash()}0`,
    'g'.repeat(64),
    '',
    added,
  ]);
  await refused(s, app, added, '合法项 H');
  await seedsRefused(s, app, '混有非法项');
  await issued(s, app, inObject, '对象里的哈希不是清单项');
  await issued(s, app, nested, '嵌套数组里的哈希不是清单项');
  await issued(s, app, upper, '大写写法的清单项被忽略，不转成小写使用');
  await issued(s, app, padded, '带空白的清单项被忽略，不去空白使用');
});

it('[AC-B1-02zzi#5][BR-ID-09 细则；D10-1034 ②] 整体非法的配置值（对象、字符串、数字、布尔、JSON null）只用种子、不放宽；同一进程里配置合法的 app 照常按配置生效', async () => {
  const s = current();
  const control = newAppId();
  const controlHash = freshHash();
  await setConfig(s, control, [controlHash]);
  await refused(s, control, controlHash, '对照：合法配置 [H]');

  const malformed: [string, (hash: string) => unknown][] = [
    ['对象包着数组', (hash) => ({ hashes: [hash] })],
    ['对象以哈希为键', (hash) => ({ [hash]: true })],
    ['对象以哈希为值', (hash) => ({ device_hash: hash })],
    ['单个字符串', (hash) => hash],
    ['数字', () => 42],
    ['布尔', () => true],
    ['JSON null', () => null],
    ['空对象', () => ({})],
  ];
  for (const [label, valueOf] of malformed) {
    const app = newAppId();
    const hash = freshHash();
    await setConfig(s, app, valueOf(hash));
    await seedsRefused(s, app, label);
    await issued(s, app, hash, `${label}：值里的哈希不是清单项`);
  }
});

it('[AC-B1-02zzi#6][BR-ID-09 细则] 按 app 隔离：A app 追加 H 只影响 A；没有配置行的 B app 与配置了别的哈希的 C app 用 H 照常签发，种子在各 app 都 20001', async () => {
  const s = current();
  const a = newAppId();
  const b = newAppId();
  const c = newAppId();
  const added = freshHash();
  await setConfig(s, a, [added]);
  await setConfig(s, c, [freshHash()]);
  await refused(s, a, added, 'A：H');
  await issued(s, b, added, 'B（无配置行）：H');
  await issued(s, c, added, 'C（配置了别的哈希）：H');
  await seedsRefused(s, a, 'A');
  await seedsRefused(s, b, 'B');
  await seedsRefused(s, c, 'C');
});

it('[AC-B1-02zzi#7][BR-ID-09 细则「运营可追加」] 运营改了配置行后下一次注册即生效、不需重启：[H1] → [H2] → []，每一步之后的第一次注册按新值判定，种子始终 20001', async () => {
  const s = current();
  const app = newAppId();
  const first = freshHash();
  const second = freshHash();
  await setConfig(s, app, [first]);
  await refused(s, app, first, '[H1]：H1');
  await issued(s, app, second, '[H1]：H2');

  await setConfig(s, app, [second]);
  await refused(s, app, second, '改成 [H2] 后：H2');
  await issued(s, app, first, '改成 [H2] 后：H1');

  await setConfig(s, app, []);
  await issued(s, app, second, '改成 [] 后：H2');
  await seedsRefused(s, app, '改成 [] 后');
});

it('[AC-B1-02zzi#8][BR-ID-09 细则；D10-1034 ②] 读取 device.invalid_hashes 失败时只用种子判定：种子各项仍 20001（不是 50001、不放过），清单外的合法哈希照常签发；读取恢复后下一次注册按配置判定', async () => {
  const s = current();
  const app = newAppId();
  const added = freshHash();
  await setConfig(s, app, [added]);
  s.readFailure.count = 0;
  s.readFailure.on = true;
  try {
    await seedsRefused(s, app, '读取失败');
    await issued(s, app, freshHash(), '读取失败：清单外的合法哈希');
  } finally {
    s.readFailure.on = false;
  }
  // The registrations above did read the key, and the read failed.
  expect(s.readFailure.count, '注册时读了配置且读取失败').toBeGreaterThan(0);
  await refused(s, app, added, '读取恢复后：H');
});
