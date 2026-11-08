import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  DEVICE_HASH_VECTORS_FILE,
  INVALID_DEVICE_HASHES_KEY,
  createInvalidDeviceHashes,
  invalidDeviceHashesOf,
  loadInvalidDeviceHashSeeds,
  parseInvalidHashSeeds,
  type InvalidDeviceHashConfigReader,
} from './invalid-device-hashes.ts';

// An independent reading of the specs file (repository root, from this test's location).
const vectors = JSON.parse(
  readFileSync(
    new URL('../../../../../../specs/device-hash.vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  hash_cases: { device_hash: string }[];
  invalid_hash_seeds: { device_hash: string }[];
};

it('[AC-B1-02c#5] loads exactly the invalid_hash_seeds of specs/device-hash.vectors.json', async () => {
  expect(DEVICE_HASH_VECTORS_FILE.pathname.endsWith('/specs/device-hash.vectors.json')).toBe(true);
  const seeds = await loadInvalidDeviceHashSeeds();
  expect([...seeds].sort()).toEqual(
    vectors.invalid_hash_seeds.map((seed) => seed.device_hash).sort(),
  );
  for (const vector of vectors.hash_cases) expect(seeds.has(vector.device_hash)).toBe(false);
});

it('refuses a list that would let invalid hashes through, without echoing a value', () => {
  const secretLooking = 'Z'.repeat(64);
  for (const document of [
    null,
    'text',
    [],
    {},
    { invalid_hash_seeds: [] },
    { invalid_hash_seeds: 'x' },
    { invalid_hash_seeds: [null] },
    { invalid_hash_seeds: [{}] },
    { invalid_hash_seeds: [{ device_hash: secretLooking }] },
    { invalid_hash_seeds: [{ device_hash: 'a'.repeat(63) }] },
  ]) {
    expect(() => parseInvalidHashSeeds(document)).toThrow(/^specs\/device-hash\.vectors\.json: /);
  }
  let message = '';
  try {
    parseInvalidHashSeeds({ invalid_hash_seeds: [{ device_hash: secretLooking }] });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('invalid_hash_seeds[0].device_hash');
  expect(message).not.toContain(secretLooking);
});

it('fails to start when the file is missing', async () => {
  await expect(
    loadInvalidDeviceHashSeeds(new URL('./no-such-file.json', import.meta.url)),
  ).rejects.toThrow();
});

// B1-02zzi: seeds ∪ the configured value of device.invalid_hashes, by app, read on every call.
const seedA = createHash('sha256').update('').digest('hex');
const seedB = createHash('sha256').update('0').digest('hex');
const added = createHash('sha256').update('operator-added').digest('hex');
const other = createHash('sha256').update('operator-added-elsewhere').digest('hex');
const seeds: ReadonlySet<string> = new Set([seedA, seedB]);
const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** A reader over app → value (absent: no row); records every read and warning. */
function harness(rows: Map<string, unknown>, failure?: 'reject' | 'throw') {
  const reads: [string, string][] = [];
  const warnings: { entry: unknown; message: string }[] = [];
  const config: InvalidDeviceHashConfigReader = {
    configValue(appId, key) {
      reads.push([appId, key]);
      if (failure === 'throw') throw new Error(`read of ${appId} failed: ${added}`);
      if (failure === 'reject') return Promise.reject(new Error(`read failed: ${added}`));
      return Promise.resolve(rows.has(appId) ? { value: rows.get(appId) } : null);
    },
  };
  const logger = {
    warn(entry: unknown, message: string) {
      warnings.push({ entry, message });
    },
  };
  const list = createInvalidDeviceHashes({ seeds, config, logger: logger as never });
  return { list, reads, warnings };
}

it('[AC-B1-02zzi#10] the list is the union: an added hash joins the seeds, and no value removes a seed', () => {
  expect(sorted(invalidDeviceHashesOf(seeds, { value: [added] }))).toEqual(
    sorted([seedA, seedB, added]),
  );
  expect(sorted(invalidDeviceHashesOf(seeds, { value: [seedA, added, added] }))).toEqual(
    sorted([seedA, seedB, added]),
  );
  expect(sorted(invalidDeviceHashesOf(seeds, { value: [] }))).toEqual(sorted(seeds));
  expect(sorted(seeds)).toEqual(sorted([seedA, seedB]));
});

it('[AC-B1-02zzi#9] no row means the seeds alone', () => {
  expect(sorted(invalidDeviceHashesOf(seeds, null))).toEqual(sorted(seeds));
});

it('[AC-B1-02zzi#12] a value that is not an array means the seeds alone', () => {
  for (const value of [null, {}, { hashes: [added] }, added, 7, true]) {
    expect(sorted(invalidDeviceHashesOf(seeds, { value }))).toEqual(sorted(seeds));
  }
});

it('[AC-B1-02zzi#11] malformed entries are ignored one by one, never rewritten; well-formed ones apply', () => {
  const value = [
    added.toUpperCase(),
    ` ${other}`,
    other.slice(2),
    [other],
    { h: other },
    5,
    null,
    added,
  ];
  expect(sorted(invalidDeviceHashesOf(seeds, { value }))).toEqual(sorted([seedA, seedB, added]));
});

it("[AC-B1-02zzi#14] reads device.invalid_hashes of each app: one app's additions stay in that app", async () => {
  const { list, reads, warnings } = harness(new Map([['a', [added]]]));
  expect(sorted(await list.forApp('a'))).toEqual(sorted([seedA, seedB, added]));
  expect(sorted(await list.forApp('b'))).toEqual(sorted(seeds));
  expect(reads).toEqual([
    ['a', INVALID_DEVICE_HASHES_KEY],
    ['b', INVALID_DEVICE_HASHES_KEY],
  ]);
  expect(INVALID_DEVICE_HASHES_KEY).toBe('device.invalid_hashes');
  expect(warnings).toEqual([]);
});

it('[AC-B1-02zzi#16] reads again on every call: a changed row applies to the next call', async () => {
  const rows = new Map<string, unknown>([['a', [added]]]);
  const { list, reads } = harness(rows);
  expect((await list.forApp('a')).has(added)).toBe(true);
  rows.set('a', [other]);
  const next = await list.forApp('a');
  expect(next.has(other)).toBe(true);
  expect(next.has(added)).toBe(false);
  expect(reads).toHaveLength(2);
});

it('[AC-B1-02zzi#15] a failed read (rejected or thrown) answers the seeds alone and logs only app_id and the key', async () => {
  for (const failure of ['reject', 'throw'] as const) {
    const { list, warnings } = harness(new Map([['a', [added]]]), failure);
    expect(sorted(await list.forApp('a'))).toEqual(sorted(seeds));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.entry).toEqual({ app_id: 'a', key: 'device.invalid_hashes' });
    expect(JSON.stringify(warnings)).not.toContain(added);
  }
});

it('[AC-B1-02zzi#11] a malformed value is warned with app_id and the key only; a well-formed one is not', async () => {
  const { list, warnings } = harness(
    new Map<string, unknown>([
      ['bad', [added, other.toUpperCase()]],
      ['whole', { hashes: [other] }],
      ['good', [added]],
    ]),
  );
  expect((await list.forApp('bad')).has(added)).toBe(true);
  expect(sorted(await list.forApp('whole'))).toEqual(sorted(seeds));
  await list.forApp('good');
  expect(warnings.map(({ entry }) => entry)).toEqual([
    { app_id: 'bad', key: 'device.invalid_hashes' },
    { app_id: 'whole', key: 'device.invalid_hashes' },
  ]);
  expect(JSON.stringify(warnings)).not.toMatch(/[0-9a-fA-F]{64}/);
});
