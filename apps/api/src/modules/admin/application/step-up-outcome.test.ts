import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import { AdminOutcomeUnknownError, isOutcomeUnknown } from './step-up-outcome.ts';

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

it('[AC-B2-02ze-OUTCOME#1] dropped connections, SQLSTATE 08 / 57P01–57P03, outcome_unknown and the agreed type are unknown, also as a cause', () => {
  for (const error of [
    coded('Connection terminated unexpectedly', '08006'),
    coded('x', '08003'),
    coded('x', '08000'),
    coded('x', '57P01'),
    coded('x', '57P02'),
    coded('x', '57P03'),
    coded('canceling statement due to statement timeout', '57014'),
    coded('read ECONNRESET', 'ECONNRESET'),
    new Error('Connection terminated unexpectedly'),
    coded('the transaction outcome is unknown', 'outcome_unknown'),
    new AdminOutcomeUnknownError(),
    new Error('wrapped', { cause: new Error('Connection terminated unexpectedly') }),
    new AggregateError([new Error('a'), coded('x', '08006')]),
  ]) {
    expect(isOutcomeUnknown(error), String(error)).toBe(true);
  }
});

it('[AC-B2-02ze-OUTCOME#2] business errors, constraint and serialization failures and HTTP answers are known roll-backs', () => {
  for (const error of [
    new Error('synthetic failure inside the transaction'),
    coded('duplicate key value violates unique constraint', '23505'),
    coded('could not serialize access', '40001'),
    new HttpException({ code: 50001 }, 500),
    'text',
    undefined,
  ]) {
    expect(isOutcomeUnknown(error), String(error)).toBe(false);
  }
});

for (const code of ['57P01', '57P02', '57P03']) {
  it(`[AC-B2-02ze-MUST#4] 第④条 正例：SQLSTATE ${code}（消息不提断线）单独即判结果未知`, () => {
    expect(isOutcomeUnknown(coded('synthetic server error', code))).toBe(true);
  });
}

it('[AC-B2-02ze-MUST#4] 第④条 反例：普通业务错误与 57 类其他码（57P04、57000）不是结果未知', () => {
  expect(isOutcomeUnknown(new Error('synthetic business failure'))).toBe(false);
  expect(isOutcomeUnknown(coded('synthetic server error', '57P04'))).toBe(false);
  expect(isOutcomeUnknown(coded('synthetic server error', '57000'))).toBe(false);
});

it('[AC-B2-02ze-R3#4] money r1 第 4 条：语句超时 57014（query_canceled）可能发生在提交途中，按结果未知（直接与作为 cause 皆然）', () => {
  const timeout = coded('canceling statement due to statement timeout', '57014');
  expect(isOutcomeUnknown(timeout)).toBe(true);
  expect(isOutcomeUnknown(new Error('wrapped', { cause: timeout }))).toBe(true);
});
