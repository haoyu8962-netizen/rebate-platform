import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { HandlerResult } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import {
  PLAIN_SHOP_URLS,
  compose,
  noAuthState,
  refusal,
  refusalShape,
  setup,
  type Fixture,
} from './kit.ts';

// B1-06zg 第 7 条与 BR-PRICE-21 细则「确保转链」：任何拒绝都不带跳转、不带普通店铺网址；data 只有
// contracts/error-codes.yaml 为该码定义的字段（50303 / 30153 无 data，30146 / 50301 只有 platform +
// reason，30101 / 30102 只有授权字段）。每个拒绝先过 refusalShape，再证明同一响应多出一个普通店铺地址
// （fallback_url 一类字段、msg、授权地址换成店铺页）时 refusalShape 必定不通过。
const database = databaseFixture(createTestDatabase);

type Arrange = (f: Fixture) => Promise<void>;
const cases: readonly { label: string; code: number; status: number; arrange: Arrange }[] = [
  {
    label: '50303 转链失败',
    code: 50303,
    status: 503,
    arrange: async (f) => {
      await f.bind('active');
      f.convertShop.mockRejectedValue(
        new UnionError('upstream_unavailable', 'synthetic', 'taobao'),
      );
    },
  },
  {
    label: '30146 shop_entry_disabled',
    code: 30146,
    status: 422,
    arrange: async (f) => {
      await f.bind('active');
      f.config.set('shop.entry.enabled.taobao', false);
    },
  },
  {
    label: '30146 shop_unavailable',
    code: 30146,
    status: 422,
    arrange: async (f) => {
      await f.bind('active');
      f.shopOf.mockResolvedValue(null);
    },
  },
  {
    label: '50301 转链开关关',
    code: 50301,
    status: 503,
    arrange: async (f) => {
      await f.bind('active');
      f.config.set('convert.enabled.taobao', false);
    },
  },
  {
    label: '30153 blocked',
    code: 30153,
    status: 422,
    arrange: async (f) => {
      await f.bind('blocked');
    },
  },
  {
    label: '30101 签发授权',
    code: 30101,
    status: 422,
    arrange: async (f) => {
      await f.bind('unbound');
    },
  },
  {
    label: '30102 签发授权',
    code: 30102,
    status: 422,
    arrange: async (f) => {
      await f.bind('invalid');
    },
  },
  {
    label: '30101 auth_unavailable',
    code: 30101,
    status: 422,
    arrange: async (f) => {
      await f.bind('unbound');
      await f.expireAccount();
    },
  },
];

function tamper(result: HandlerResult, patch: Record<string, unknown>, msg?: string) {
  const data = result.envelope.data as Record<string, unknown> | undefined;
  return {
    status: result.status,
    envelope: {
      ...result.envelope,
      ...(msg === undefined ? {} : { msg }),
      data: { ...data, ...patch },
    },
  } as HandlerResult;
}

it.each(cases)(
  '[AC-B1-06zg#41] $label：data 只有该码的契约字段；多出 fallback_url 一类的普通店铺地址即不合格',
  async ({ code, status, arrange }) => {
    const f = await setup(database());
    await arrange(f);
    const result = await compose(f)();
    await refusal(result, f, code, status);
    if (code !== 30101 && code !== 30102) await noAuthState(result, f);
    for (const address of PLAIN_SHOP_URLS) {
      for (const key of ['fallback_url', 'shop_url', 'url', 'redirect_url', 'h5'])
        expect(() => refusalShape(tamper(result, { [key]: address }), code, status)).toThrow();
      expect(() =>
        refusalShape(tamper(result, { extra: { href: address } }), code, status),
      ).toThrow();
      expect(() => refusalShape(tamper(result, {}, `请前往 ${address}`), code, status)).toThrow();
    }
    expect(() =>
      refusalShape(
        tamper(result, { jump: { primary: { type: 'h5', value: PLAIN_SHOP_URLS[0] } } }),
        code,
        status,
      ),
    ).toThrow();
    const data = result.envelope.data as Record<string, unknown> | undefined;
    if (typeof data?.auth_url === 'string') {
      const onShop = `${PLAIN_SHOP_URLS[0]}/authorize?state=synthetic`;
      expect(() => refusalShape(tamper(result, { auth_url: onShop }), code, status)).toThrow();
    }
  },
);

it.each([
  {
    label: 'UnionError 报文与字段带店铺页',
    error: () =>
      Object.assign(
        new UnionError(
          'upstream_rejected',
          `synthetic: ${PLAIN_SHOP_URLS[1]} is not promotable`,
          'taobao',
        ),
        { url: PLAIN_SHOP_URLS[0], fallbackUrl: PLAIN_SHOP_URLS[3] },
      ),
  },
  {
    label: '普通 Error 报文带店铺页',
    error: () => new Error(`synthetic failure ${PLAIN_SHOP_URLS[2]}`),
  },
])(
  '[AC-B1-06zg#42] convertShop 失败（$label）→ 50303，不把上游给的普通店铺地址转出',
  async ({ error }) => {
    const f = await setup(database());
    await f.bind('active');
    f.convertShop.mockRejectedValue(error());
    const result = await compose(f)();
    await refusal(result, f, 50303, 503);
    expect(Object.keys((result.envelope.data as object | undefined) ?? {})).toEqual([]);
    expect(f.convertShop).toHaveBeenCalledTimes(1);
  },
);
