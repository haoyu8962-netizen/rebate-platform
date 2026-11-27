// B1-01zzz (D10-3534 ① / D10-3592): the trusted H5 origins of this environment, the CORS allow
// list of the api entry's /v1. It is the same list the signed bridge_origins whitelist of
// GET /v1/config carries: for every App with configuration items, its usable bridge_origins
// (normalized, as BridgeOriginsSigner signs it), else the https origin of its h5_base_url; the
// union over all Apps. An App whose h5_base_url has no https origin contributes nothing (its
// bridge_origins cannot be signed either). No other configuration key.
//
// Read afresh on every call (two cross-App SELECTs through configValuesByKey, no cache): a console
// change takes effect on the next request. Rejects when a read rejects; the caller decides.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

import { BRIDGE_ORIGINS_KEY, h5Origin, storedBridgeOrigins } from '../domain/bridge-origins.ts';
import { configValuesByKey } from '../infra/config-values-by-key.ts';

const H5_BASE_URL_KEY = 'h5_base_url';

export async function readAppH5Origins(db: Kysely<DB>): Promise<ReadonlySet<string>> {
  const [baseUrls, bridgeOrigins] = await Promise.all([
    configValuesByKey(db, H5_BASE_URL_KEY),
    configValuesByKey(db, BRIDGE_ORIGINS_KEY),
  ]);
  const bridgeByApp = new Map(bridgeOrigins.map((row) => [row.appId, row.value]));
  const origins = new Set<string>();
  for (const { appId, value } of baseUrls) {
    const home = h5Origin(value);
    if (home === null) continue;
    const bridge = bridgeByApp.get(appId);
    const stored = bridge === undefined ? null : storedBridgeOrigins(bridge, home);
    for (const origin of stored ?? [home]) origins.add(origin);
  }
  return origins;
}
