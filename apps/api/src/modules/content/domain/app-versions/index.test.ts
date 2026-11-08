import { describe, expect, it } from 'vitest';
import { compareClientVersions } from '../../../platform/index.ts';
import {
  APP_VERSION_STORE_URL_SCHEMES,
  checkAppVersionSave,
  compareAppVersions,
  isMinSupportedRaise,
  isStoreUrl,
  validateAppVersionSave,
} from './index.ts';
import type { AppVersionSaveInput } from './index.ts';

function row(overrides: Partial<AppVersionSaveInput> = {}): AppVersionSaveInput {
  return {
    platform: 'android',
    channel: 'huawei',
    latest_version: '2.0.0',
    min_supported_version: '2.0.0',
    recommended_version: null,
    update_title: 't',
    update_notes: 'n',
    store_url: 'https://example.test/app',
    default_store: 's1',
    store_listings: [
      { store: 's1', listed_version: '2.0.0' },
      { store: 's2', listed_version: '2.0.0' },
    ],
    confirmed_stores: [],
    ...overrides,
  };
}

describe('validateAppVersionSave', () => {
  it('[AC-F1-02zb] accepts a well-formed row', () => {
    expect(validateAppVersionSave(row(), ['s1', 's2'])).toStrictEqual({
      ok: true,
      store_table_empty: false,
    });
  });

  it.each([
    'https:///x',
    'https://',
    'https:',
    'https:store.test/a',
    'https://@/x',
    'https://:80/x',
    'https://:abc/x',
    'https://store.test:abc/x',
    'https://store.test:/x',
    'https://[::1/x',
    'https://store.test/a\tb',
    'market:///x',
    'http://store.test/a',
    'urn:store:demo',
    'javascript:alert(1)',
    'data:text/plain,a',
    'file:///etc/x',
    'ftp://store.test/a',
  ])('[AC-F1-02zb] store_url %s is rejected', (store_url) => {
    expect(validateAppVersionSave(row({ store_url }), ['s1', 's2'])).toStrictEqual({
      ok: false,
      fields: ['store_url'],
      store_table_empty: false,
    });
  });

  it.each([
    'https://[abc]/x',
    'market://[zz]',
    'https://[1.2.3.4]/x',
    'https://[::g]/x',
    'https://[v1.fe80::1]/x',
    'https://user@[abc]:443/x',
    'https://[fe80::1%25eth0]/x',
    'https://[fe80::1%eth0]/x',
    'https://[]/x',
  ])('[AC-F1-02zzzh] bracketed store_url host %s is rejected', (store_url) => {
    expect(isStoreUrl(store_url)).toBe(false);
    expect(validateAppVersionSave(row({ store_url }), ['s1', 's2'])).toStrictEqual({
      ok: false,
      fields: ['store_url'],
      store_table_empty: false,
    });
  });

  it.each([
    'https://[2001:db8::1]:8443/app',
    'https://[::ffff:192.0.2.1]/x',
    'market://[2001:db8::1]/d?id=1',
    'https://user@[2001:DB8::1]/x',
  ])('[AC-F1-02zzzh] bracketed IPv6 store_url %s is accepted', (store_url) => {
    expect(isStoreUrl(store_url)).toBe(true);
  });

  it('[AC-F1-02zb] the scheme allow-list is exactly https, market, appmarket, itms-apps', () => {
    expect(APP_VERSION_STORE_URL_SCHEMES).toStrictEqual([
      'https',
      'market',
      'appmarket',
      'itms-apps',
    ]);
    expect(Object.isFrozen(APP_VERSION_STORE_URL_SCHEMES)).toBe(true);
  });

  it.each([
    'https://apps.apple.com/app/id1',
    'HTTPS://store.test/a',
    'market://details?id=demo',
    'appmarket://details?id=demo',
    'itms-apps://apps.apple.com/app/id1',
    'https://user@example.test:8443/a',
    'https://[::1]/a',
    'https://[::1]:443/a',
  ])('[AC-F1-02zb] store_url %s is accepted', (store_url) => {
    expect(isStoreUrl(store_url)).toBe(true);
  });

  it.each(['web', 'h5', undefined])(
    '[AC-F1-02zb] an invalid platform %s reports exactly platform, skipping channel pairing',
    (platform) => {
      expect(
        validateAppVersionSave({ ...row(), platform, channel: 'nope' }, ['s1', 's2']),
      ).toStrictEqual({ ok: false, fields: ['platform'], store_table_empty: false });
    },
  );

  it('[AC-F1-02zb] reports every invalid field in declaration order', () => {
    expect(
      validateAppVersionSave(
        { ...row(), channel: 'agc', latest_version: '1.0', store_url: 'x', confirmed_stores: 1 },
        [],
      ),
    ).toStrictEqual({
      ok: false,
      fields: ['channel', 'latest_version', 'store_url', 'confirmed_stores'],
      store_table_empty: true,
    });
  });

  it('[AC-F1-02zb] a non-object input fails every field', () => {
    const result = validateAppVersionSave(null, []);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.fields).toContain('platform');
  });
});

describe('compareAppVersions', () => {
  it.each([
    ['1.10.0', '1.9.0'],
    ['1.9.0', '1.10.0'],
    ['1.0.0', '1.0.0'],
    ['9007199254740993.0.0', '9007199254740992.0.0'],
    ['0.0.1', '0.1.0'],
  ])('[AC-F1-02zb] %s vs %s matches compareClientVersions', (left, right) => {
    expect(compareAppVersions(left, right)).toBe(compareClientVersions(left, right));
  });

  it('[AC-F1-02zb] throws on malformed versions', () => {
    expect(() => compareAppVersions('1.0', '1.0.0')).toThrow(TypeError);
  });
});

describe('isMinSupportedRaise', () => {
  it('[AC-F1-02zb] raise only when the new minimum is set and higher', () => {
    expect(isMinSupportedRaise(null, { min_supported_version: '1.0.0' })).toBe(true);
    expect(
      isMinSupportedRaise({ min_supported_version: '1.0.0' }, { min_supported_version: null }),
    ).toBe(false);
    expect(
      isMinSupportedRaise({ min_supported_version: '1.9.0' }, { min_supported_version: '1.10.0' }),
    ).toBe(true);
  });
});

describe('checkAppVersionSave', () => {
  it('[AC-F1-02zb] untouched trigger fields skip the check', () => {
    const before = row({ store_listings: [{ store: 's1', listed_version: null }] });
    expect(checkAppVersionSave(before, { ...before, update_title: 'x' })).toStrictEqual({
      ok: true,
      confirmed: [],
    });
  });

  it('[AC-F1-02zb] default store below the new minimum fails on the changed fields only', () => {
    expect(checkAppVersionSave(row(), row({ min_supported_version: '2.0.1' }))).toStrictEqual({
      ok: false,
      fields: ['min_supported_version'],
    });
  });

  it('[AC-F1-02zb] lagging stores must be confirmed and are returned in listing order', () => {
    const after = row({
      store_listings: [
        { store: 's3', listed_version: '1.0.0' },
        { store: 's1', listed_version: '2.0.0' },
        { store: 's2', listed_version: null },
      ],
    });
    expect(checkAppVersionSave(row(), after)).toStrictEqual({
      ok: false,
      fields: ['confirmed_stores'],
    });
    expect(
      checkAppVersionSave(row(), { ...after, confirmed_stores: ['s2', 's3', 'zz'] }),
    ).toStrictEqual({ ok: true, confirmed: ['s3', 's2'] });
  });
});
