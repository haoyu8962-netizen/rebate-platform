// B1-02zzi: an independent reading of specs/device-hash.vectors.json (the seeds of config
// device.invalid_hashes, 08 BR-ID-09 细则「设备标识的无效值」) and small value helpers.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const vectors = JSON.parse(
  readFileSync(new URL('../../../../specs/device-hash.vectors.json', import.meta.url), 'utf8'),
) as { invalid_hash_seeds: { device_hash: string }[] };

/** The config key named by BR-ID-09 细则 and registered by B1-02zzh. */
export const KEY = 'device.invalid_hashes';

/** invalid_hash_seeds[].device_hash, in file order. */
export const SEEDS: readonly string[] = vectors.invalid_hash_seeds.map((seed) => seed.device_hash);

/** device_hash as POST /v1/devices accepts it: 64 lowercase hex characters. */
export const WELL_FORMED = /^[0-9a-f]{64}$/;

/** A fresh well-formed hash that is on no list. */
export function freshHash(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

export function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}
