// Config key device.invalid_hashes (BR-ID-09 细则「设备标识的无效值」): its seeds are the
// `invalid_hash_seeds` of specs/device-hash.vectors.json, read once when the entry starts; the
// list of one app is those seeds united with the app's configured value (B1-02zzi below).
import { readFile } from 'node:fs/promises';
import type { RootLogger } from '../../platform/index.ts';
import { isWellFormedDeviceHash } from '../domain/device.ts';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const DEVICE_HASH_VECTORS_FILE = new URL(
  '../../../../../../specs/device-hash.vectors.json',
  import.meta.url,
);

const WHERE = 'specs/device-hash.vectors.json';

/**
 * The set of seed hashes. Throws when the document is not an object with a non-empty
 * `invalid_hash_seeds` array whose every entry has a well-formed `device_hash`: a broken list
 * must stop the entry instead of letting invalid hashes through.
 */
export function parseInvalidHashSeeds(document: unknown): ReadonlySet<string> {
  const seeds =
    typeof document === 'object' && document !== null
      ? (document as { invalid_hash_seeds?: unknown }).invalid_hash_seeds
      : undefined;
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new Error(`${WHERE}: invalid_hash_seeds must be a non-empty array`);
  }
  const hashes = new Set<string>();
  for (const [index, seed] of seeds.entries()) {
    const hash =
      typeof seed === 'object' && seed !== null
        ? (seed as { device_hash?: unknown }).device_hash
        : undefined;
    if (!isWellFormedDeviceHash(hash)) {
      throw new Error(
        `${WHERE}: invalid_hash_seeds[${String(index)}].device_hash must be 64 lowercase hex characters`,
      );
    }
    hashes.add(hash);
  }
  return hashes;
}

export async function loadInvalidDeviceHashSeeds(
  file: URL = DEVICE_HASH_VECTORS_FILE,
): Promise<ReadonlySet<string>> {
  return parseInvalidHashSeeds(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

// B1-02zzi (D10-1034 ②): the list of one app is the seeds united with the configured value of
// device.invalid_hashes (operations may only add; a seed can never be removed). A missing,
// unreadable or malformed value never loosens the list: the seeds always apply.

/** A config_items row as content's reader answers it (its value only). */
export interface InvalidDeviceHashConfig {
  readonly value: unknown;
}

/** content's configValue for (app, 'device.invalid_hashes'); null when the app has no row. */
export interface InvalidDeviceHashConfigReader {
  configValue(appId: string, key: string): Promise<InvalidDeviceHashConfig | null>;
}

export interface InvalidDeviceHashesOptions {
  /** loadInvalidDeviceHashSeeds(): the specs seeds, read once when the entry starts. */
  readonly seeds: ReadonlySet<string>;
  readonly config: InvalidDeviceHashConfigReader;
  /**
   * Warned when the read fails or the value is malformed; the entry carries app_id and the key
   * only (never a hash or the value).
   */
  readonly logger?: Pick<RootLogger, 'warn'>;
}

/** The configuration key (BR-ID-09 细则; registered by B1-02zzh as config.risk, object). */
export const INVALID_DEVICE_HASHES_KEY = 'device.invalid_hashes';

/** The invalid-hash list of one app, read for each registration. */
export interface InvalidDeviceHashes {
  /** Never rejects: a failed read answers the seeds alone. */
  forApp(appId: string): Promise<ReadonlySet<string>>;
}

/**
 * The seeds united with every well-formed hash (64 lowercase hex characters) at the top level of
 * a configured array. Other entries are ignored; a missing row or a value that is not an array
 * gives the seeds alone. The seeds set is not modified.
 */
export function invalidDeviceHashesOf(
  seeds: ReadonlySet<string>,
  configured: InvalidDeviceHashConfig | null,
): ReadonlySet<string> {
  const hashes = new Set(seeds);
  const value = configured?.value;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      if (isWellFormedDeviceHash(item)) hashes.add(item);
    }
  }
  return hashes;
}

/** Is the configured value (a row) anything but an array of well-formed hashes? */
function isMalformed(configured: InvalidDeviceHashConfig): boolean {
  const { value } = configured;
  return (
    !Array.isArray(value) || !(value as unknown[]).every((item) => isWellFormedDeviceHash(item))
  );
}

/** Reads the app's device.invalid_hashes on every call (no cache); see invalidDeviceHashesOf. */
export function createInvalidDeviceHashes(
  options: InvalidDeviceHashesOptions,
): InvalidDeviceHashes {
  const { seeds, config, logger } = options;
  return {
    async forApp(appId: string): Promise<ReadonlySet<string>> {
      let configured: InvalidDeviceHashConfig | null;
      try {
        configured = await config.configValue(appId, INVALID_DEVICE_HASHES_KEY);
      } catch {
        // Never looser (D10-1034 ②): the seeds alone; the error itself is not logged, as it may
        // carry the statement's parameters.
        logger?.warn(
          { app_id: appId, key: INVALID_DEVICE_HASHES_KEY },
          'identity: device.invalid_hashes read failed; the specs seeds alone apply',
        );
        return invalidDeviceHashesOf(seeds, null);
      }
      if (configured !== null && isMalformed(configured)) {
        logger?.warn(
          { app_id: appId, key: INVALID_DEVICE_HASHES_KEY },
          'identity: device.invalid_hashes has malformed entries; they are ignored',
        );
      }
      return invalidDeviceHashesOf(seeds, configured);
    },
  };
}
