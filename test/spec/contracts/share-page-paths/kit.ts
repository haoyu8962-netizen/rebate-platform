// CT-26zj (D10-1246, as D10-1232): contracts/bridge.schema.json share.open share_page_paths takes
// the share pages' real routes. path_pattern is an anchored regular expression over the normalised
// path (the $comment of share_page_paths; BR-ATTR-29 细则). Expectations come from the routes the
// server issues, not from the file under test:
// - product_share: `/<link_id>`, link_id the server-issued uuid of links.link_id (contract LinkId →
//   Id, a UUIDv7 string; the H5 landing reads exactly one path segment);
// - invite_landing: `/i/<invite_code>` (growth my-invite landing_url), the code 6 characters from the
//   32-character alphabet of 08 BR-INV-01 (contract MyInvite.invite_code ^[2-9A-HJ-NP-Z]{6}$);
// - download_guide: no route on trunk, stays null.
import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
export const BRIDGE_FILE = 'contracts/bridge.schema.json';

export type SharePageKey = 'product_share' | 'invite_landing' | 'download_guide';

export interface SharePagePath {
  readonly page: unknown;
  readonly path_pattern: unknown;
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  expect(value, `${label} 不能为 null`).not.toBeNull();
  expect(typeof value, `${label} 必须是对象`).toBe('object');
  expect(Array.isArray(value), `${label} 不能是数组`).toBe(false);
  return value as Readonly<Record<string, unknown>>;
}

/** share.open share_page_paths of contracts/bridge.schema.json. */
export function sharePagePaths(): Readonly<Record<SharePageKey, SharePagePath>> {
  const file = new URL(BRIDGE_FILE, ROOT);
  // A missing file fails inside the test body, never as an ENOENT posing as red.
  expect(existsSync(file), `缺少契约文件 ${BRIDGE_FILE}`).toBe(true);
  const doc = object(JSON.parse(readFileSync(file, 'utf8')) as unknown, BRIDGE_FILE);
  const methods = object(doc['methods'], 'methods');
  const share = object(methods['share.open'], 'methods["share.open"]');
  const paths = object(share['share_page_paths'], 'share.open share_page_paths');
  for (const key of ['product_share', 'invite_landing', 'download_guide'] as const) {
    object(paths[key], `share_page_paths.${key}`);
  }
  return paths as unknown as Readonly<Record<SharePageKey, SharePagePath>>;
}

/** The path_pattern of a page as an anchored ^/…$ regular expression (no flags). */
export function patternOf(key: SharePageKey): RegExp {
  const pattern = sharePagePaths()[key].path_pattern;
  expect(typeof pattern, `share_page_paths.${key}.path_pattern 必须是字符串`).toBe('string');
  const source = String(pattern);
  expect(source.startsWith('^/'), `${key}: 以 ^/ 锚定开头`).toBe(true);
  expect(source.endsWith('$'), `${key}: 以 $ 锚定结尾`).toBe(true);
  let compiled: RegExp | undefined;
  let error: unknown;
  try {
    compiled = new RegExp(source);
  } catch (caught) {
    error = caught;
  }
  expect(error, `${key}: 是合法正则`).toBeUndefined();
  return compiled!;
}

/** Server-issued link ids (lower-case UUIDv7, the contract's example among them). */
export const LINK_IDS = [
  '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70',
  '0199a3b4-5c6d-7000-8000-0000000015a1',
  '019a6f2e-9b3c-7d41-b2a8-5e6f7a8b9c0d',
  '0199ffff-ffff-7fff-bfff-ffffffffffff',
] as const;

/** Invite codes of the BR-INV-01 alphabet (2-9 and A-Z without I and O), length 6. */
export const INVITE_CODES = ['K7M2QX', '23456Z', 'ABCDEF', 'HJNPRT', '99ZZ22', 'WXY789'] as const;

const SAMPLE_LINK = LINK_IDS[0];
const SAMPLE_CODE = INVITE_CODES[0];

/** Paths that are no product share page. */
export const NOT_PRODUCT_SHARE: readonly string[] = [
  '',
  '/',
  '//',
  SAMPLE_LINK,
  `//${SAMPLE_LINK}`,
  `/${SAMPLE_LINK}/`,
  `/${SAMPLE_LINK}/tpwd`,
  `/${SAMPLE_LINK}x`,
  `/x${SAMPLE_LINK}`,
  `/${SAMPLE_LINK.slice(0, -1)}`,
  `/${SAMPLE_LINK.replaceAll('-', '')}`,
  '/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
  '/not-a-link-id',
  '/a/b',
  `/a/${SAMPLE_LINK}`,
  `/i/${SAMPLE_CODE}`,
  `/i/${SAMPLE_LINK}`,
  `/${SAMPLE_CODE}`,
  '/r/LinkLanding',
  '/share-pages',
  `/v1/share-pages/${SAMPLE_LINK}`,
];

/** Paths that are no invite landing page. */
export const NOT_INVITE_LANDING: readonly string[] = [
  '',
  '/',
  '/i',
  '/i/',
  `i/${SAMPLE_CODE}`,
  `//i/${SAMPLE_CODE}`,
  `/i//${SAMPLE_CODE}`,
  `/i/${SAMPLE_CODE}/`,
  `/i/${SAMPLE_CODE}/x`,
  `/I/${SAMPLE_CODE}`,
  `/ii/${SAMPLE_CODE}`,
  `/x/${SAMPLE_CODE}`,
  `/x/i/${SAMPLE_CODE}`,
  `/${SAMPLE_CODE}`,
  // Length is always 6 (BR-INV-01).
  '/i/K7M2Q',
  '/i/K7M2QXA',
  // 0, 1, I and O are outside the alphabet ("K0M2QX 不可能被生成").
  '/i/K0M2QX',
  '/i/K1M2QX',
  '/i/K7I2QX',
  '/i/K7O2QX',
  '/i/K7M2Q-',
  `/i/${SAMPLE_LINK}`,
  `/${SAMPLE_LINK}`,
];
