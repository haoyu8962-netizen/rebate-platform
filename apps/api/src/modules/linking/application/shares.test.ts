// B1-15w unit tests: the pure parts of POST /v1/shares and the use case's early answers with
// in-memory ports (no database). The database behaviour (one transaction, rollback, replay, the
// share page) is the rule tests' (test/spec/linking/shares/**).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FixedClock, GovernanceError, type HandlerResult } from '../../platform/index.ts';
import { DemoUnionError, UnionError } from '../../union/index.ts';
import type { Caller } from '../ports.ts';
import {
  SHARE_PRICE_BASIS,
  conversionRefusal,
  createShares,
  isFreshRaw,
  isIdentifiedMinor,
  linkRawRef,
  shareIdentity,
  shareConversion,
  shareImages,
  shareUrlOf,
  type SharesOptions,
} from './shares.ts';

const APP = 'synthetic_app';
const USER = '0199a3b4-5c6d-7000-8000-0000000000a1';
const DEVICE = '0199a3b4-5c6d-7000-8000-0000000000a2';
const NOW = '2026-10-30T02:00:00.000Z';
const TEXTS_FILE = new URL('../../../../../../contracts/texts.default.json', import.meta.url);

interface TextsFile {
  readonly texts: Readonly<Record<string, string>>;
}

describe('shares helpers (B1-15w)', () => {
  it('[AC-B1-15w] the price-basis lines are the texts of contracts/texts.default.json', () => {
    const { texts } = JSON.parse(readFileSync(TEXTS_FILE, 'utf8')) as TextsFile;
    expect(SHARE_PRICE_BASIS).toEqual({
      withCoupon: texts['price_basis'],
      general: texts['price_basis.general'],
    });
  });

  it('[AC-B1-15w] BR-ID-26: 18 is reached at 00:00 Beijing of the day after the 18th birthday', () => {
    const at = new Date(Date.parse(NOW));
    expect(isIdentifiedMinor('2008-10-29', at)).toBe(false);
    expect(isIdentifiedMinor('2008-10-30', at)).toBe(true);
    expect(isIdentifiedMinor(null, at)).toBe(false);
  });

  it('[AC-B1-15w] the share link is the converted web URL; Pinduoduo prefers its short link', () => {
    const jdUrl = 'https://u.example.test/a';
    expect(shareUrlOf('jd', { kind: 'url', url: jdUrl })).toBe(jdUrl);
    const pdd = shareUrlOf('pdd', {
      kind: 'url',
      url: 'https://p.example.test/long',
      mobile_short_url: 'https://p.example.test/s',
    });
    expect(pdd).toBe('https://p.example.test/s');
    expect(shareUrlOf('jd', { kind: 'url', url: 'javascript:alert(1)' })).toBeNull();
    const baichuan = shareUrlOf('jd', {
      kind: 'baichuan',
      item: { platform: 'taobao', item_id: '1' },
      promotionSlot: 'mm_1_2_3',
      relationId: '9',
    });
    expect(baichuan).toBeNull();
  });

  it('[AC-B1-15w] BR-PROD-05 ①: a fresh links raw ID stands in for a missing item_ref', () => {
    const nowMs = Date.parse(NOW);
    const row = {
      product_key: 'jd:i_100012043978',
      raw_item_id: 'dm0123456789_100012043978',
      raw_fetched_at: new Date(nowMs - 1_800_000),
    };
    expect(linkRawRef(row, APP, 'jd', nowMs)).toEqual({
      appId: APP,
      platform: 'jd',
      productKey: 'jd:i_100012043978',
      rawItemId: 'dm0123456789_100012043978',
      fetchedAt: '2026-10-30T01:30:00.000Z',
      source: 'link',
    });
    const stale = { ...row, raw_fetched_at: '2026-10-30T01:29:59.999Z' };
    expect(linkRawRef(stale, APP, 'jd', nowMs)).toBeNull();
    expect(linkRawRef({ ...row, raw_item_id: null }, APP, 'jd', nowMs)).toBeNull();
    expect(linkRawRef({ ...row, product_key: null }, APP, 'jd', nowMs)).toBeNull();
    expect(linkRawRef(undefined, APP, 'jd', nowMs)).toBeNull();
    expect(isFreshRaw('not an instant', nowMs)).toBe(false);
  });

  it('[AC-B1-15w] conversion failures: refused 30121, off shelf 30141, anything else 50303', () => {
    expect(conversionRefusal(new UnionError('upstream_rejected', 'x', 'jd'))).toBe(30121);
    expect(conversionRefusal(new UnionError('item_unavailable', 'x', 'jd'))).toBe(30141);
    expect(conversionRefusal(new DemoUnionError('demo_delisted', 'x', 'jd'))).toBe(30141);
    expect(conversionRefusal(new UnionError('upstream_unavailable', 'x', 'jd'))).toBe(50303);
    expect(conversionRefusal(new UnionError('rate_limited', 'x', 'jd'))).toBe(50303);
    expect(conversionRefusal(new GovernanceError('circuit_open', 'union.jd', 'x'))).toBe(50303);
    expect(conversionRefusal(new Error('x'))).toBe(50303);
  });

  it('[AC-B1-15w] the conversion identity is the share slot and the attr_code, with the lk', () => {
    const parts = { promotionSlot: 'slot-share', attrCode: 'abcd1234' };
    const jd = shareIdentity(APP, { platform: 'jd', ...parts }, null);
    expect(jd.claims).toEqual({
      appId: APP,
      userId: 'abcd1234',
      platform: 'jd',
      promotionSlot: 'slot-share',
      relationId: null,
    });
    expect(jd.subUnionId).toBe('n_abcd1234');
    expect(shareIdentity(APP, { platform: 'jd', ...parts }, 'k7').subUnionId).toBe('n_abcd1234_k7');
    const pdd = shareIdentity(APP, { platform: 'pdd', ...parts }, null);
    expect(pdd.custom_parameters).toEqual({ app: 'n', uid: 'abcd1234', sc: 'share' });
    expect(Object.hasOwn(pdd, 'subUnionId')).toBe(false);
  });
});

describe('shareConversion (B1-06zd)', () => {
  const short = 'https://s.example.test/t';
  const coupon = 'https://u.example.test/c';
  const url = (parts: object) => ({
    kind: 'url' as const,
    url: 'https://item.example.test',
    ...parts,
  });

  it('[AC-B1-06zd] Taobao: the promotion link and the token go together', () => {
    expect(
      shareConversion('taobao', url({ short_url: short, coupon_click_url: coupon, tpwd: 'x' })),
    ).toEqual({ shareUrl: short, promoUrl: coupon, tpwd: 'x' });
  });

  it('[AC-B1-06zd] BR-ATTR-10: Taobao without a token, or a blank one, generates nothing', () => {
    expect(
      shareConversion('taobao', url({ short_url: short, coupon_click_url: coupon })),
    ).toBeNull();
    expect(shareConversion('taobao', url({ short_url: short, tpwd: '  ' }))).toBeNull();
    expect(shareConversion('taobao', url({ tpwd: 'x' }))).toBeNull();
  });

  it('[AC-B1-06zd] jd and pdd keep the link alone, no token and no promotion link', () => {
    expect(shareConversion('pdd', url({ short_url: short }))).toEqual({
      shareUrl: short,
      tpwd: null,
      promoUrl: null,
    });
    expect(shareConversion('jd', url({ short_url: short }))).toEqual({
      shareUrl: 'https://item.example.test',
      tpwd: null,
      promoUrl: null,
    });
  });
});

describe('shareImages (B1-15z)', () => {
  const MAIN = 'https://img.example.test/p/main.jpg';
  const gallery = (count: number): string[] =>
    Array.from({ length: count }, (_, n) => `https://img.example.test/p/${String(n)}.jpg`);

  it('[AC-B1-15z] main image first, then the gallery in order, each entry only a url', () => {
    const [one, two] = gallery(2) as [string, string];
    expect(shareImages({ main_image_url: MAIN, image_urls: [two, one] })).toEqual([
      { url: MAIN },
      { url: two },
      { url: one },
    ]);
  });

  it('[AC-B1-15z] duplicates are dropped before the cut to 9, keeping the first position', () => {
    const eight = gallery(8);
    const result = shareImages({ main_image_url: MAIN, image_urls: [MAIN, ...eight, MAIN] });
    expect(result.map((image) => image.url)).toEqual([MAIN, ...eight]);
    const ten = shareImages({ main_image_url: MAIN, image_urls: gallery(10) });
    expect(ten.map((image) => image.url)).toEqual([MAIN, ...gallery(8)]);
  });

  it('[AC-B1-15z] only one of the two fields, or neither', () => {
    expect(shareImages({ main_image_url: MAIN })).toEqual([{ url: MAIN }]);
    const [one] = gallery(1) as [string];
    expect(shareImages({ image_urls: [one] })).toEqual([{ url: one }]);
    expect(shareImages({})).toEqual([]);
  });

  it('[AC-B1-15z] a frozen gallery is read, not changed, and its address stays exact', () => {
    const exact = 'https://IMG.example.test/p/%E5%9B%BE.JPG?w=800&h=800#top';
    const frozen = Object.freeze([exact, MAIN]);
    expect(shareImages({ main_image_url: MAIN, image_urls: frozen })).toEqual([
      { url: MAIN },
      { url: exact },
    ]);
    expect(frozen).toEqual([exact, MAIN]);
  });
});

/** Ports that must not be reached by the early answers below. */
function unreachable(): never {
  throw new Error('not reached');
}

interface Logged {
  readonly table: string;
  readonly values: Record<string, unknown>;
}

function fixture(overrides: {
  caller?: Caller;
  birthDate?: string | null;
  switchOn?: boolean;
  offReason?: string;
}) {
  const logged: Logged[] = [];
  const db = {
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => ({
        execute: () => {
          logged.push({ table, values });
          return Promise.resolve([]);
        },
      }),
    }),
  };
  const executed: unknown[] = [];
  const caller = overrides.caller ?? { appId: APP, userId: USER, deviceId: DEVICE };
  const switchOn = overrides.switchOn !== false;
  const options = {
    db,
    clock: new FixedClock(NOW),
    appEnv: 'test',
    logger: { warn: () => undefined },
    callerContext: { current: () => Promise.resolve(caller) },
    config: {
      configValue: (_app: string, key: string) =>
        Promise.resolve(
          key.startsWith('convert.off_reason.')
            ? overrides.offReason === undefined
              ? null
              : { value: overrides.offReason, version: 1 }
            : { value: switchOn, version: 1 },
        ),
    },
    pids: { getActivePid: unreachable },
    registry: { get: unreachable },
    idempotency: {
      async execute(request: unknown, handler: () => Promise<HandlerResult>) {
        executed.push(request);
        const result = await handler();
        return { status: result.status, body: JSON.stringify(result.envelope), source: 'handler' };
      },
    },
    products: {},
    itemRefs: { verify: unreachable },
    quoter: { quote: unreachable },
    authUrl: { get: unreachable },
    verifiedBirthDate: () => Promise.resolve(overrides.birthDate ?? null),
  } as unknown as SharesOptions;
  return { service: createShares(options), logged, executed };
}

const INPUT = {
  body: { platform: 'jd' as const, product_key: 'jd:100012043978' },
  idempotencyKey: 'synthetic-key-0001',
  traceId: 'synthetic-trace',
  client: 'ios' as const,
};

describe('shares use case: early answers (B1-15w)', () => {
  it('[AC-B1-15w] a guest gets 10001 without reaching the idempotency store', async () => {
    const { service, executed } = fixture({
      caller: { appId: APP, userId: null, deviceId: DEVICE },
    });
    const result = await service.create(INPUT);
    expect(result).toMatchObject({ status: 401, envelope: { code: 10001 } });
    expect(executed).toEqual([]);
  });

  it('[AC-B1-15w] an identified minor gets 30413 self_minor, logged without a link', async () => {
    const { service, logged, executed } = fixture({ birthDate: '2012-03-15' });
    const result = await service.create(INPUT);
    expect(result).toEqual({
      status: 422,
      envelope: {
        code: 30413,
        msg: '未满 18 周岁，暂不开放邀请与分享',
        data: { reason: 'self_minor' },
        trace_id: 'synthetic-trace',
      },
    });
    expect(executed).toEqual([
      expect.objectContaining({ appId: APP, method: 'POST', path: '/v1/shares', body: INPUT.body }),
    ]);
    expect(logged).toEqual([
      {
        table: 'link_logs',
        values: expect.objectContaining({
          link_id: null,
          event: 'convert',
          scene: 'share',
          pid_scene: 'share',
          result_code: 30413,
        }),
      },
    ]);
  });

  it('[AC-B1-15w] the platform conversion switched off is 50301 with convert.off_reason (B1-06zl)', async () => {
    const { service } = fixture({ switchOn: false, offReason: 'maintenance' });
    const result = await service.create(INPUT);
    expect(result).toMatchObject({ status: 503, envelope: { code: 50301 } });
    expect(result.envelope.data).toStrictEqual({ platform: 'jd', reason: 'maintenance' });
  });

  it('[AC-B1-06zl] switched off with no convert.off_reason: 50301 data { platform, reason=not_launched }', async () => {
    const { service } = fixture({ switchOn: false });
    const result = await service.create(INPUT);
    expect(result).toMatchObject({ status: 503, envelope: { code: 50301 } });
    expect(result.envelope.data).toStrictEqual({ platform: 'jd', reason: 'not_launched' });
  });
});
