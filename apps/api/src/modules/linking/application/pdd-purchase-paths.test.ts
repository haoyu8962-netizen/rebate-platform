import { describe, expect, it } from 'vitest';
import {
  buildDefaultLinkJump,
  JUMP_PLAN_SCHEME,
  pddPurchasePaths,
  planVariant,
} from './link-open-conversion.ts';

const MOBILE = 'https://example.test/purchase?p_id=slot&custom_parameters=%7B%7D';
const SCHEMA = 'synthetic-pdd://synthetic/landing?p_id=slot&opaque=a%2fb';
const EXPIRE = '2026-11-24T00:15:00.000Z';

describe('Pinduoduo purchase paths from the conversion answer (B1-06zp)', () => {
  it('[AC-B1-06zp] the declared scheme + :// keeps schema_url exactly; the web page is the mobile URL', () => {
    expect(pddPurchasePaths(MOBILE, SCHEMA, 'synthetic-pdd')).toEqual({
      scheme: SCHEMA,
      universalLink: MOBILE,
      h5: MOBILE,
    });
  });

  it('[AC-B1-06zp] no scheme step when schema_url is missing, empty, not text or not under the scheme', () => {
    for (const schemaUrl of [
      undefined,
      '',
      42,
      'https://example.test/landing',
      'synthetic-pdd-other://x',
      'synthetic-pdd:x',
      ` ${SCHEMA}`,
    ]) {
      expect(pddPurchasePaths(MOBILE, schemaUrl, 'synthetic-pdd').scheme).toBeNull();
    }
    expect(pddPurchasePaths(MOBILE, SCHEMA, null).scheme).toBeNull();
  });

  it('[AC-B1-06zp] installed → [scheme, h5], not installed → [h5], unknown → [scheme, h5] once', () => {
    const paths = pddPurchasePaths(MOBILE, SCHEMA, 'synthetic-pdd');
    const plan = (installed: 'true' | 'false' | 'unknown') =>
      buildDefaultLinkJump({
        platform: 'pdd',
        client: 'android',
        installed,
        paths,
        expireAt: EXPIRE,
      });
    const both = {
      primary: { type: 'scheme', value: SCHEMA },
      fallbacks: [{ type: 'h5', value: MOBILE }],
      expire_at: EXPIRE,
    };
    expect(plan('true')).toEqual(both);
    expect(plan('unknown')).toEqual(both);
    expect(plan('false')).toEqual({
      primary: { type: 'h5', value: MOBILE },
      fallbacks: [],
      expire_at: EXPIRE,
    });
  });

  it('[AC-B1-06zp] every plan variant carries the jump-plan scheme, so no pre-change variant matches', () => {
    for (const installed of ['true', 'false', 'unknown']) {
      for (const client of ['ios', 'android', 'harmony', 'h5', 'web']) {
        const variant = planVariant(client, installed);
        expect(variant).toBe(`${client}:${installed}:${JUMP_PLAN_SCHEME}`);
        expect(variant).not.toBe(`${client}:${installed}`);
        expect(variant.split(':')[0]).toBe(client);
      }
    }
  });
});
