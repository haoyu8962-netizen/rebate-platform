// B2-09y 源码旁单元测试：人工查询入队键（同一提现单同一 execute_seq 一把键，不含请求号）。
import { expect, it } from 'vitest';
import { manualQueryJobKey } from './admin-unknown-payouts.ts';

const ID = '019a0000-0000-7000-8000-000000000001';
const OTHER = '019a0000-0000-7000-8000-000000000002';

it('[AC-B2-09y#U1] 同一提现单同一 execute_seq 每次都是同一把键，不随请求变化', () => {
  expect(manualQueryJobKey(ID, 1)).toBe(`${ID}:1:manual`);
  expect(manualQueryJobKey(ID, 1)).toBe(manualQueryJobKey(ID, 1));
});

it('[AC-B2-09y#U2] 不同提现单、不同 execute_seq 的键互不相同，也不与执行任务的键 `{id}:{seq}` 相撞', () => {
  const keys = [
    manualQueryJobKey(ID, 1),
    manualQueryJobKey(ID, 2),
    manualQueryJobKey(OTHER, 1),
    `${ID}:1`,
    `${ID}:2`,
  ];
  expect(new Set(keys).size).toBe(keys.length);
});

it('[AC-B2-09y#U3] 键符合队列 singletonKey 的字符集与长度（1..200，[A-Za-z0-9:._+-]）', () => {
  const key = manualQueryJobKey(ID, 2147483647);
  expect(key).toMatch(/^[A-Za-z0-9:._+-]{1,200}$/u);
});
