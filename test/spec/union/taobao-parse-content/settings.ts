import { vi } from 'vitest';
import type { ConfigValue, ContentReader } from '../../../../apps/api/src/modules/content/index.ts';

export const thirdPartyParseKey = 'parse.third_party.enabled';

export function thirdPartyParseSettings(values: ReadonlyMap<string, ConfigValue>) {
  const configValue = vi.fn<ContentReader['configValue']>(async (appId, key) => {
    const value = values.get(appId);
    return key === thirdPartyParseKey && value !== undefined ? { value, version: 1 } : null;
  });
  return { config: { configValue } };
}

export function enableThirdPartyParse(appId: string) {
  return thirdPartyParseSettings(new Map([[appId, true]]));
}
