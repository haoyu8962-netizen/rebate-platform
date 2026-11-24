import { expect, it } from 'vitest';
import {
  createLinkOpenConversion,
  type JdPddIdentity,
  type LinkOpenApps,
} from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { conversionFixture, conversionInput } from '../open-jdpdd/kit.ts';

const SCHEME = 'synthetic-pdd';
const APPS: LinkOpenApps = {
  apps: {
    jd: {
      status: 'candidate',
      ios: { query_schemes: [] },
      android: { packages: [] },
      harmony: { query_schemes: [] },
    },
    pdd: {
      status: 'verified',
      ios: { query_schemes: [SCHEME] },
      android: { packages: ['test.synthetic.pdd'] },
      harmony: { query_schemes: [] },
    },
  },
};

const PID = 'synthetic-self_buy';
const CUSTOM = '{"app":"n","uid":"demo0001","sc":"self_buy"}';
const ATTRIBUTION = `p_id=${PID}&custom_parameters=${encodeURIComponent(CUSTOM)}`;
const MOBILE_URL = `https://example.test/purchase?${ATTRIBUTION}&opaque=web%2fdata`;
const SCHEMA_URL = `${SCHEME}://synthetic/landing?opaque=app%2fdata&${ATTRIBUTION}&opaque=second`;
const H5 = { type: 'h5', value: MOBILE_URL };
const ANSWER = {
  kind: 'url',
  url: MOBILE_URL,
  mobile_short_url: 'https://example.test/short',
  browser_url: 'https://example.test/browser',
  tz_schema_url: `${SCHEME}://synthetic/alternate`,
} as const;

it.each([
  ['ios', 'true'],
  ['android', 'unknown'],
] as const)(
  '[AC-B1-06zp#1] %s 已装状态 %s 按回包原样给出 scheme → H5，同端未装只给出 H5',
  async (client, installed) => {
    const f = conversionFixture('pdd');
    f.convert.mockResolvedValue({ ...ANSWER, schema_url: SCHEMA_URL });
    const conversion = createLinkOpenConversion({ ...f.options, apps: APPS });
    const input = { ...conversionInput('pdd'), client };

    const uninstalled = await conversion.convert({ ...input, installed: 'false' });
    expect(uninstalled.primary).toEqual(H5);
    expect(uninstalled.fallbacks).toEqual([]);

    const jump = await conversion.convert({
      ...input,
      installed,
      idempotencyKey: 'synthetic-next-open',
    });
    expect(jump.primary).toEqual({ type: 'scheme', value: SCHEMA_URL });
    expect(jump.fallbacks).toEqual([H5]);
    expect(f.convert).toHaveBeenCalledTimes(2);

    const identity = f.convert.mock.calls[1]![1] as JdPddIdentity;
    for (const step of [jump.primary, ...jump.fallbacks]) {
      const params = new URL(step.value).searchParams;
      expect(params.getAll('p_id')).toEqual([identity.claims.promotionSlot]);
      const custom = params.getAll('custom_parameters');
      expect(custom).toHaveLength(1);
      expect(JSON.parse(custom[0]!)).toEqual(identity.custom_parameters);
    }

    const undeclared = await createLinkOpenConversion({
      ...f.options,
      apps: {
        apps: { ...APPS.apps, pdd: { ...APPS.apps.pdd, ios: { query_schemes: [] } } },
      },
    }).convert({ ...input, installed, idempotencyKey: 'synthetic-no-declaration' });
    expect(undeclared.primary).toEqual(H5);
    expect(undeclared.fallbacks).toEqual([]);
  },
);

it.each([
  ['缺失', {}],
  ['为空', { schema_url: '' }],
  ['是网页地址', { schema_url: 'https://example.test/landing' }],
  ['scheme 名只有相同开头', { schema_url: `${SCHEME}-other://synthetic/landing` }],
  ['缺少双斜杠', { schema_url: `${SCHEME}:synthetic/landing` }],
] as const)(
  '[AC-B1-06zp#2] schema_url %s 时，已装和 unknown 都只给出 mobile_url',
  async (_label, extra) => {
    const f = conversionFixture('pdd');
    f.convert.mockResolvedValue({ ...ANSWER, ...extra });
    const conversion = createLinkOpenConversion({ ...f.options, apps: APPS });

    for (const installed of ['true', 'unknown'] as const) {
      const jump = await conversion.convert({ ...conversionInput('pdd'), installed });
      expect(jump.primary).toEqual(H5);
      expect(jump.fallbacks).toEqual([]);
    }
  },
);
