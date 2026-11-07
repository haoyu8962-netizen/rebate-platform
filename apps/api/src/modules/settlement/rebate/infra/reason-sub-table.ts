// B2-04zze: settlement's sub-reason tables (specs/reason-sub-map/<platform>.csv, D10-862 ①), read
// once per process the first time a settlement port is built (the ports are built at start), then
// shared; a missing or bad file throws there, so the process does not start with half a table.
// Only Taobao has automatic sub-reasons; jd / pdd write none (D10-867), so they have no table.
import { readFileSync } from 'node:fs';
import { loadReasonSubMap, type ReasonSubMap } from '../../../orders/index.ts';
import type { ReasonSubMaps } from '../domain/reason-sub.ts';

/** Platforms with an automatic sub-reason table. */
const TABLE_PLATFORMS = ['taobao'] as const;

let loaded: ReasonSubMaps | undefined;

/** One read of the platform's table file; a missing file is null (loadReasonSubMap refuses it). */
function readTableCsv(platform: string): string | null {
  try {
    // specs/ at the repository root; same depth from src/ and dist/.
    return readFileSync(
      new URL(`../../../../../../../specs/reason-sub-map/${platform}.csv`, import.meta.url),
      'utf8',
    );
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** The process' tables, loaded on the first call. */
export function defaultReasonSubMaps(): ReasonSubMaps {
  if (loaded !== undefined) return loaded;
  const maps = new Map<string, ReasonSubMap>();
  for (const platform of TABLE_PLATFORMS) {
    maps.set(platform, loadReasonSubMap(platform, readTableCsv(platform)));
  }
  loaded = (platform) => maps.get(platform) ?? null;
  return loaded;
}
