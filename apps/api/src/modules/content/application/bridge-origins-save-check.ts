// F1-02zzzb (D10-610): the save-time check of bridge_origins (config.risk). A write that sets it
// (single update, batch or rollback) is refused with 20001 unless the value is {origins} with a
// non-empty list of distinct canonical https origins (lowercase host; no path, query, fragment,
// credentials, wildcard, trailing slash or :443) that contains the h5_base_url origin, taken from
// the same write when it sets h5_base_url, else from the stored row. ContentAdminModule always
// combines it with the assembler's checks; it runs only for writes of its own keys.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { BRIDGE_ORIGINS_KEY, bridgeOriginsSaveValid } from '../domain/bridge-origins.ts';
import type { ConfigItemSaveCheck } from './config-item-admin.ts';

const H5_BASE_URL_KEY = 'h5_base_url';

export function bridgeOriginsSaveCheck(): ConfigItemSaveCheck {
  return {
    keys: [BRIDGE_ORIGINS_KEY, H5_BASE_URL_KEY],
    refusals(stored, written) {
      if (!written.has(BRIDGE_ORIGINS_KEY)) return [];
      const h5BaseUrl = written.has(H5_BASE_URL_KEY)
        ? written.get(H5_BASE_URL_KEY)
        : stored.get(H5_BASE_URL_KEY);
      return bridgeOriginsSaveValid(written.get(BRIDGE_ORIGINS_KEY), h5BaseUrl)
        ? []
        : [BRIDGE_ORIGINS_KEY];
    },
  };
}
