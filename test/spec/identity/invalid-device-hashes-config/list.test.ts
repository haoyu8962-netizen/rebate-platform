// B1-02zzi (08 BR-ID-09 细则「设备标识的无效值」; D10-1034 ②): the invalid-hash list of one app is
// the specs seeds united with the well-formed hashes (64 lowercase hex characters) at the top level
// of the configured array of device.invalid_hashes. Operations may only add: a seed is never
// removed. A missing row, a value that is not an array, malformed entries or a failed read never
// loosen the list (the seeds always apply); malformed entries are ignored, never rewritten.
// The reader reads the app's row on every call, so a change applies to the next registration.
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  createInvalidDeviceHashes,
  invalidDeviceHashesOf,
  type InvalidDeviceHashConfigReader,
} from '../../../../apps/api/src/modules/identity/infra/invalid-device-hashes.ts';
import { freshHash, KEY, SEEDS, sorted, WELL_FORMED } from './seeds.ts';

function seedSet(): Set<string> {
  expect(SEEDS.length, '前置条件：specs 给出了种子').toBeGreaterThan(0);
  return new Set(SEEDS);
}

function list(value: unknown): string[] {
  return sorted(invalidDeviceHashesOf(seedSet(), { value }));
}

const hash = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString('hex'));

/** A fake content reader over (app, key) → value; `calls` records every read. */
function fakeConfig(rows: Map<string, unknown>) {
  const calls: [string, string][] = [];
  const config: InvalidDeviceHashConfigReader = {
    configValue: (appId, key) => {
      calls.push([appId, key]);
      const name = `${appId}\u0000${key}`;
      return Promise.resolve(rows.has(name) ? { value: rows.get(name) } : null);
    },
  };
  return { calls, config };
}
function row(appId: string, value: unknown): [string, unknown] {
  return [`${appId}\u0000${KEY}`, value];
}

it('[AC-B1-02zzi#9][BR-ID-09 细则；D10-1034 ②] 没有配置行时清单恰为种子；传入的种子集合不被改动', () => {
  const seeds = seedSet();
  expect(sorted(invalidDeviceHashesOf(seeds, null))).toEqual(sorted(SEEDS));
  expect(sorted(seeds)).toEqual(sorted(SEEDS));
});

it('[AC-B1-02zzi#10][BR-ID-09 细则「运营可追加」；D10-1034 ②] 追加取并集、删不掉种子：种子加 H、只写 [H]、空数组、只写部分种子，结果都含全部种子', () => {
  const added = freshHash();
  const withAdded = sorted([...SEEDS, added]);
  expect(list([...SEEDS, added])).toEqual(withAdded);
  expect(list([added])).toEqual(withAdded);
  expect(list([added, added])).toEqual(withAdded);
  expect(list([])).toEqual(sorted(SEEDS));
  expect(list([SEEDS[0]])).toEqual(sorted(SEEDS));
  const seeds = seedSet();
  invalidDeviceHashesOf(seeds, { value: [added] });
  expect(sorted(seeds), '种子集合不被改动').toEqual(sorted(SEEDS));
});

it('[AC-B1-02zzi#11][BR-ID-09 细则；D10-1034 ②] 数组里的非法项被忽略、不被改写后使用，合法项照用', () => {
  const added = freshHash();
  const upper = freshHash();
  const padded = freshHash();
  const inObject = freshHash();
  const nested = freshHash();
  const result = list([
    123,
    0,
    null,
    true,
    false,
    { device_hash: inObject },
    [nested],
    upper.toUpperCase(),
    ` ${padded} `,
    `${padded}\n`,
    freshHash().slice(1),
    `${freshHash()}0`,
    'g'.repeat(64),
    '',
    added,
  ]);
  expect(result).toEqual(sorted([...SEEDS, added]));
});

it('[AC-B1-02zzi#12][BR-ID-09 细则；D10-1034 ②] 整体非法的配置值（对象、字符串、数字、布尔、JSON null）只用种子', () => {
  const inside = freshHash();
  for (const value of [
    { hashes: [inside] },
    { [inside]: true },
    { device_hash: inside },
    {},
    inside,
    '',
    42,
    0,
    true,
    false,
    null,
  ]) {
    expect(list(value), JSON.stringify(value)).toEqual(sorted(SEEDS));
  }
});

it('[AC-B1-02zzi#13][BR-ID-09 细则；D10-1034 ②] 任意配置值：结果恰为种子并上数组顶层的合法哈希，种子永远在内（性质测试）', () => {
  const element = fc.oneof(
    hash,
    hash.map((value) => value.toUpperCase()),
    hash.map((value) => ` ${value}`),
    fc.jsonValue(),
  );
  const seedsArb = fc.uniqueArray(hash, { minLength: 1, maxLength: 8 });
  fc.assert(
    fc.property(
      seedsArb,
      fc.oneof(fc.jsonValue(), fc.array(element, { maxLength: 12 })),
      (seedList, value) => {
        const seeds = new Set(seedList);
        const expected = new Set(seedList);
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string' && WELL_FORMED.test(item)) expected.add(item);
          }
        }
        expect(sorted(invalidDeviceHashesOf(seeds, { value }))).toEqual(sorted(expected));
        expect(sorted(seeds)).toEqual(sorted(seedList));
      },
    ),
  );
});

it('[AC-B1-02zzi#14][BR-ID-09 细则] 按请求的 app 读 device.invalid_hashes：A 追加的 H 只进 A 的清单，没有配置行的 B 只用种子', async () => {
  const added = freshHash();
  const { calls, config } = fakeConfig(new Map([row('app_a', [added])]));
  const hashes = createInvalidDeviceHashes({ seeds: seedSet(), config });
  expect(sorted(await hashes.forApp('app_a'))).toEqual(sorted([...SEEDS, added]));
  expect(sorted(await hashes.forApp('app_b'))).toEqual(sorted(SEEDS));
  expect(calls).toContainEqual(['app_a', KEY]);
  expect(calls).toContainEqual(['app_b', KEY]);
  for (const [, key] of calls) expect(key).toBe(KEY);
});

it('[AC-B1-02zzi#15][BR-ID-09 细则；D10-1034 ②] 读取口拒绝或直接抛错时不报错，只用种子判定', async () => {
  const failing: InvalidDeviceHashConfigReader[] = [
    { configValue: () => Promise.reject(new Error('database unavailable')) },
    {
      configValue: () => {
        throw new Error('database unavailable');
      },
    },
  ];
  for (const config of failing) {
    const hashes = createInvalidDeviceHashes({ seeds: seedSet(), config });
    expect(sorted(await hashes.forApp('app_a'))).toEqual(sorted(SEEDS));
  }
});

it('[AC-B1-02zzi#16][BR-ID-09 细则「运营可追加」] 两次调用之间改了配置行：下一次调用即按新值，不沿用旧值', async () => {
  const first = freshHash();
  const second = freshHash();
  const rows = new Map([row('app_a', [first])]);
  const { config } = fakeConfig(rows);
  const hashes = createInvalidDeviceHashes({ seeds: seedSet(), config });
  expect(sorted(await hashes.forApp('app_a'))).toEqual(sorted([...SEEDS, first]));
  rows.set(...row('app_a', [second]));
  expect(sorted(await hashes.forApp('app_a'))).toEqual(sorted([...SEEDS, second]));
  rows.set(...row('app_a', { not: 'a list' }));
  expect(sorted(await hashes.forApp('app_a'))).toEqual(sorted(SEEDS));
});
