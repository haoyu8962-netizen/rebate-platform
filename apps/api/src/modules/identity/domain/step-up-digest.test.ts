import { expect, it } from 'vitest';
import {
  digestMatches,
  isDigestAction,
  payoutAccountDigest,
  STEP_UP_FAILURE,
  wechatPayoutDigest,
  withdrawDigest,
} from './step-up-digest.ts';

const ID = '019a0000-0000-7000-8000-0000000000bb';

it('[AC-B1-02zzzb#1] digest strings follow the contract: w:<id>:<amount_fen>, p:<method>:<hmac>, p:wechat:<attempt>', () => {
  expect(withdrawDigest(ID, 10000n)).toBe(`w:${ID}:10000`);
  expect(payoutAccountDigest('alipay', 'h1')).toBe('p:alipay:h1');
  expect(payoutAccountDigest('bank_card', 'h2')).toBe('p:bank_card:h2');
  expect(wechatPayoutDigest(ID)).toBe(`p:wechat:${ID}`);
  expect(withdrawDigest(ID, 9_999_900n)).toBe(`w:${ID}:9999900`);
});

it('[AC-B1-02zzzb#8] only withdraw and payout_account_change are bound', () => {
  expect(isDigestAction('withdraw')).toBe(true);
  expect(isDigestAction('payout_account_change')).toBe(true);
  expect(isDigestAction('phone_change')).toBe(false);
  expect(isDigestAction('account_deletion')).toBe(false);
});

it('[AC-B1-02zzzb#6] digestMatches: equal strings only; a token without digest (null) never matches', () => {
  expect(digestMatches('p:alipay:h1', 'p:alipay:h1')).toBe(true);
  expect(digestMatches('p:alipay:h1', 'p:alipay:h2')).toBe(false);
  expect(digestMatches('p:alipay:h1', 'p:bank_card:h1')).toBe(false);
  expect(digestMatches(null, 'p:alipay:h1')).toBe(false);
  expect(digestMatches(`p:wechat:${ID}`, 'p:alipay:h1')).toBe(false);
  // Fails closed: a value that is not a string (an untyped caller passing nothing) never matches.
  expect(digestMatches(undefined as unknown as null, 'p:alipay:h1')).toBe(false);
  expect(digestMatches('p:alipay:h1', null)).toBe(false);
});

it('[AC-B1-02zzzb#6] STEP_UP_FAILURE is the one step-up failure: 10003, HTTP 403, the stage ⑫ text', () => {
  expect(STEP_UP_FAILURE).toEqual({ code: 10003, status: 403, msg: '需要二次验证' });
  expect(Object.isFrozen(STEP_UP_FAILURE)).toBe(true);
});
