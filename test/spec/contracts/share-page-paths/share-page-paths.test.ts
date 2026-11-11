// CT-26zj (D10-1246, as D10-1232): share.open share_page_paths take the share pages' real routes;
// see kit.ts for where each expectation comes from.
import { expect, it } from 'vitest';
import * as bridge from '../../../../packages/contracts-ts/src/bridge.gen.ts';
import {
  INVITE_CODES,
  LINK_IDS,
  NOT_INVITE_LANDING,
  NOT_PRODUCT_SHARE,
  patternOf,
  sharePagePaths,
} from './kit.ts';

it('[AC-CT-26zj#4] product_share.path_pattern 是锚定 ^/…$ 的正则：匹配服务端签发的 /<link_id>（uuid），不匹配根路径、多段路径、邀请落地页与非 uuid', () => {
  const pattern = patternOf('product_share');
  for (const linkId of LINK_IDS) {
    expect(pattern.test(`/${linkId}`), `/${linkId}`).toBe(true);
  }
  for (const path of NOT_PRODUCT_SHARE) {
    expect(pattern.test(path), JSON.stringify(path)).toBe(false);
  }
  // Not the invite landing's paths either.
  for (const code of INVITE_CODES) {
    expect(pattern.test(`/i/${code}`), `/i/${code}`).toBe(false);
  }
});

it('[AC-CT-26zj#5] invite_landing.path_pattern 是锚定 ^/…$ 的正则：匹配 /i/<邀请码>（6 位，BR-INV-01 字符集），不匹配其他路径、错长度、字符集外与商品分享页', () => {
  const pattern = patternOf('invite_landing');
  for (const code of INVITE_CODES) {
    expect(pattern.test(`/i/${code}`), `/i/${code}`).toBe(true);
  }
  for (const path of NOT_INVITE_LANDING) {
    expect(pattern.test(path), JSON.stringify(path)).toBe(false);
  }
  for (const linkId of LINK_IDS) {
    expect(pattern.test(`/${linkId}`), `/${linkId}`).toBe(false);
  }
});

it('[AC-CT-26zj#6] download_guide 主干无路由仍为 null；三页仍各有 page 名；生成的 bridge.gen.ts sharePagePaths 与 bridge.schema.json 一致', () => {
  const paths = sharePagePaths();
  // The two filled patterns (red while trunk keeps them null).
  expect(typeof paths.product_share.path_pattern, 'product_share.path_pattern').toBe('string');
  expect(typeof paths.invite_landing.path_pattern, 'invite_landing.path_pattern').toBe('string');
  expect(paths.download_guide.path_pattern).toBeNull();
  for (const key of ['product_share', 'invite_landing', 'download_guide'] as const) {
    expect(typeof paths[key].page, `${key}.page`).toBe('string');
    expect(String(paths[key].page).length, `${key}.page`).toBeGreaterThan(0);
  }
  const generated = bridge.sharePagePaths as unknown as Readonly<
    Record<string, { readonly page: unknown; readonly path_pattern: unknown }>
  >;
  expect(Object.keys(generated).sort()).toEqual([
    'download_guide',
    'invite_landing',
    'product_share',
  ]);
  for (const key of ['product_share', 'invite_landing', 'download_guide'] as const) {
    expect(generated[key], `bridge.gen.ts sharePagePaths.${key}`).toEqual({
      page: paths[key].page,
      path_pattern: paths[key].path_pattern,
    });
  }
});
