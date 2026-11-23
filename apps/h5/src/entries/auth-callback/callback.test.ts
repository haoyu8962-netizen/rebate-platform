import { expect, it } from 'vitest';
import { callbackTarget } from './callback.ts';

it('accepts a leading "?" or none', () => {
  expect(callbackTarget('code=C&state=S')).toBe('couli://auth/taobao?code=C&state=S');
  expect(callbackTarget('?code=C&state=S')).toBe('couli://auth/taobao?code=C&state=S');
});

it('lets error win over a valid code without leaking the code', () => {
  expect(callbackTarget('?code=C&error=x&state=S')).toBe('couli://auth/taobao?state=S&error=1');
});

it('rejects a state of 257 characters even on the error branch', () => {
  expect(callbackTarget(`?error=x&state=${'s'.repeat(257)}`)).toBeNull();
  expect(callbackTarget(`?error=x&state=${'s'.repeat(256)}`)).toBe(
    `couli://auth/taobao?state=${'s'.repeat(256)}&error=1`,
  );
});
