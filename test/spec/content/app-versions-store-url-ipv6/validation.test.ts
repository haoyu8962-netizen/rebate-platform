// F1-02zzzh §9.2: a bracketed store_url host must be an IPv6 literal (node:net isIPv6), with no
// zone id; anything else is 20001 [store_url]. Everything else about store_url is unchanged.
// Judged only through validateAppVersionSave; fields must be exactly ['store_url'].
// §9.5: every case here is red on main. Regression controls live inside the red cases, after the
// new-rule assertions (#1: other rules unchanged; #3: valid IPv6 literals still accepted).
import { isIPv6 } from 'node:net';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { validateAppVersionSave } from '../../../../apps/api/src/modules/content/domain/app-versions/index.ts';
import { row } from '../app-versions-rules/kit.ts';

const STORES = ['a', 'b'];
const REJECTED = { ok: false, fields: ['store_url'], store_table_empty: false };
const ACCEPTED = { ok: true, store_table_empty: false };
const SCHEMES = ['https', 'market', 'appmarket', 'itms-apps'] as const;

function judge(store_url: string): ReturnType<typeof validateAppVersionSave> {
  return validateAppVersionSave(row({ store_url }), STORES);
}

it('[AC-F1-02zzzh#1] store_url 方括号内不是 IPv6 字面量即拒收，其余规则不变', () => {
  // New rule: bracketed hosts that are not IPv6 literals.
  for (const store_url of [
    'https://[abc]/x',
    'market://[zz]',
    'https://[1.2.3.4]/x',
    'https://[::g]/x',
    'https://[v1.fe80::1]/x',
    'https://[abc]:443/x',
    'https://user@[abc]/x',
    'appmarket://[1:2:3:4:5:6:7:8:9]/x',
    'itms-apps://[:::1]/x',
    'https://[12345::1]/x',
    'https://[1::2::3]/x',
    'https://[::ffff:1.2.3.256]/x',
    'market://[localhost]/d?id=1',
  ]) {
    expect(judge(store_url), store_url).toStrictEqual(REJECTED);
  }
  // Control: the existing rejections are unchanged.
  for (const store_url of [
    'https://[]/x',
    'market://[]',
    'https://user@[]/x',
    'https://[::1/x',
    'https://[::1]x/a',
    'https://[::1]]/a',
    'https://[::1]:/a',
    'https://[::1]:abc/a',
    'https://[::1]:-1/a',
    'https://[::1] /a',
    'https://[::1]/a\tb',
    'http://[::1]/a',
    'ftp://[2001:db8::1]/a',
    'https:///x',
    'https://',
    'https://@/x',
    'https://store.test:abc/x',
    'market:///x',
  ]) {
    expect(judge(store_url), JSON.stringify(store_url)).toStrictEqual(REJECTED);
  }
  // Control: non-bracketed hosts and authority-less forms stay accepted.
  for (const store_url of [
    'https://store.test/a',
    'HTTPS://store.test/a',
    'https://user@store.test:8443/a',
    'https://1.2.3.4/x',
    'https://abc/x',
    'market://details?id=demo',
    'appmarket://details?id=demo',
    'itms-apps://apps.apple.com/app/id1',
  ]) {
    expect(judge(store_url), store_url).toStrictEqual(ACCEPTED);
  }
});

it.each([
  'https://[fe80::1%25eth0]/x',
  'https://[fe80::1%eth0]/x',
  'https://[fe80::1%25eth0]:8443/x',
  'market://[fe80::1%251]/d?id=1',
  'https://[::1%]/x',
])('[AC-F1-02zzzh#2] store_url 方括号主机带 zone id 从严拒收 %s', (store_url) => {
  expect(judge(store_url)).toStrictEqual(REJECTED);
});

it('[AC-F1-02zzzh#3] 方括号主机以 isIPv6 为准：非 IPv6 的十六进制 / 冒号 / 点串拒收，合法 IPv6 照常接受', () => {
  // New rule: any hex / colon / dot string that is not IPv6 is rejected inside brackets.
  const notIpv6 = fc
    .string({
      unit: fc.constantFrom(...'0123456789abcdefABCDEF:.'),
      minLength: 1,
      maxLength: 39,
    })
    .filter((host) => !isIPv6(host));
  fc.assert(
    fc.property(
      notIpv6,
      fc.constantFrom(...SCHEMES),
      fc.constantFrom('', ':443'),
      (host, scheme, port) => {
        const store_url = `${scheme}://[${host}]${port}/x`;
        expect(judge(store_url), store_url).toStrictEqual(REJECTED);
      },
    ),
    propParams(),
  );
  // Control: valid IPv6 literals, fixed and generated, stay accepted.
  for (const store_url of [
    'https://[::1]/x',
    'https://[2001:db8::1]:8443/app',
    'https://[::ffff:192.0.2.1]/x',
    'market://[2001:db8::1]/d?id=1',
    'https://[2001:DB8::1]/x',
    'https://[1:2:3:4:5:6:7:8]/x',
    'itms-apps://[::]/x',
    'appmarket://[fe80::1]',
    'https://user@[::1]:443/x',
    'https://[::1]?q=1',
    'https://[::1]#frag',
  ]) {
    expect(judge(store_url), store_url).toStrictEqual(ACCEPTED);
  }
  fc.assert(
    fc.property(
      fc.ipV6().filter((ip) => isIPv6(ip)),
      fc.constantFrom(...SCHEMES),
      fc.constantFrom('', ':443', ':8443'),
      (ip, scheme, port) => {
        const store_url = `${scheme}://[${ip}]${port}/x`;
        expect(judge(store_url), store_url).toStrictEqual(ACCEPTED);
      },
    ),
    propParams(),
  );
}, 900_000);
