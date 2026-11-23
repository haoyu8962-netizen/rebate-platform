import { expect, it } from 'vitest';
import { callbackTarget } from '../../../../apps/h5/src/entries/auth-callback/callback.ts';

const DEEP_LINK = 'couli://auth/taobao';
const MAX_CODE = 'Ab0-_xyz'.repeat(32);
const MAX_STATE = 'Xy9_-abc'.repeat(32);

it.each([
  ['?state=State_9-a&code=Code-0_b', 'Code-0_b', 'State_9-a'],
  ['?code=A&state=_', 'A', '_'],
  [`?code=${MAX_CODE}&state=${MAX_STATE}`, MAX_CODE, MAX_STATE],
  ['?code=%41%2D%5F&state=%30%5F%2D', 'A-_', '0_-'],
])('[AC-F1-11d#1] 白名单内的值按 code、state 顺序透传（%s）', (search, code, state) => {
  expect(callbackTarget(search)).toBe(`${DEEP_LINK}?code=${code}&state=${state}`);
});

it.each([
  ['?error=access_denied&state=State_9-a', 'State_9-a'],
  ['?state=Z&error=', 'Z'],
  ['?error&state=Z', 'Z'],
  ['?code=Valid&state=Z&error=denied%26code%3Dleak&error_description=private', 'Z'],
  ['?code=invalid%2Fcode&state=Z&error=denied', 'Z'],
])('[AC-F1-11d#2] error 存在时只带合格的 state 和 error=1（%s）', (search, state) => {
  expect(callbackTarget(search)).toBe(`${DEEP_LINK}?state=${state}&error=1`);
});

it.each([
  '',
  '?code=Code',
  '?state=State',
  '?code=&state=State',
  '?code=Code&state=',
  '?error=denied',
  '?error=denied&state=',
  '?error=denied&state=bad%2Fstate',
  `?error=denied&state=${MAX_STATE}S`,
  '?error_description=access_denied&state=State',
])('[AC-F1-11d#3] 必需参数缺失或拒绝回调的 state 不合格时不跳转（%s）', (search) => {
  expect(callbackTarget(search)).toBeNull();
});

it.each([
  MAX_CODE + 'x',
  'valid%0A',
  '%20valid',
  'a+b',
  'a%2Bb',
  'a.b',
  'a%2Fb',
  'a%26b%3D1',
  'a%23b',
  '%E5%87%91',
  'a%00b',
  '%ZZ',
])('[AC-F1-11d#4] code 或 state 含白名单外字符或超长时不跳转（%s）', (invalid) => {
  expect(callbackTarget(`?code=${invalid}&state=State`)).toBeNull();
  expect(callbackTarget(`?code=Code&state=${invalid}`)).toBeNull();
});

it.each([
  ['?code=&code=Good&state=State', null],
  ['?code=Code&state=bad%2Fstate&state=Good', null],
  ['?error=denied&state=&state=Good', null],
  ['?code=First&code=Second&state=One&state=Two', `${DEEP_LINK}?code=First&state=One`],
  ['?error=denied&state=One&state=Two', `${DEEP_LINK}?state=One&error=1`],
])('[AC-F1-11d#5] 重复的 code、state 各只采用第一个值（%s）', (search, target) => {
  expect(callbackTarget(search)).toBe(target);
});

it('[AC-F1-11d#6] 两种回调都丢弃额外参数和错误详情', () => {
  const extra = '&token=private&redirect_uri=https%3A%2F%2Fexample.test&error_description=why';
  expect(callbackTarget(`?code=C&state=S${extra}`)).toBe(`${DEEP_LINK}?code=C&state=S`);
  expect(callbackTarget(`?error=denied&state=S${extra}`)).toBe(`${DEEP_LINK}?state=S&error=1`);
});
