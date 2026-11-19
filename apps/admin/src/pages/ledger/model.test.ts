// Unit tests of the ledger export outcome (F1-08fc): enveloped 5xx is unknown, 4xx stays failed,
// explicit refusals win over the 5xx rule.
import { expect, it } from 'vitest';
import { AdminApiError, type AdminApiErrorDetails } from '../../providers/data/index.ts';
import { exportRejected } from './model.ts';

function error(details: Partial<AdminApiErrorDetails>): AdminApiError {
  return new AdminApiError({
    kind: 'api',
    code: 50001,
    msg: '',
    data: null,
    httpStatus: 500,
    ...details,
  });
}

it('[AC-F1-08fc-UNIT#1] 带外壳的 5xx（业务码或 code 0）按结果未知', () => {
  expect(exportRejected(error({ httpStatus: 500 }))).toEqual({ kind: 'unknown' });
  expect(exportRejected(error({ httpStatus: 503 }))).toEqual({ kind: 'unknown' });
  expect(exportRejected(error({ kind: 'http', code: -3, httpStatus: 500 }))).toEqual({
    kind: 'unknown',
  });
});

it('[AC-F1-08fc-UNIT#2] 4xx 仍是确定失败，202 带任务仍是已创建', () => {
  expect(exportRejected(error({ code: 40000, httpStatus: 400 }))).toEqual({ kind: 'failed' });
  expect(exportRejected(error({ kind: 'http', code: -3, httpStatus: 404 }))).toEqual({
    kind: 'failed',
  });
  expect(exportRejected(error({ kind: 'request', code: -4, httpStatus: 0 }))).toEqual({
    kind: 'failed',
  });
  expect(
    exportRejected(error({ kind: 'http', code: -3, httpStatus: 202, data: { id: 'EX1' } })),
  ).toEqual({ kind: 'created', id: 'EX1' });
});

it('[AC-F1-08fc-UNIT#3] 10403 与会计日 20001 即使是 5xx 也按服务端明确拒绝', () => {
  expect(exportRejected(error({ code: 10403, httpStatus: 503 }))).toEqual({ kind: 'forbidden' });
  expect(
    exportRejected(
      error({ code: 20001, httpStatus: 500, data: { fields: ['accounting_date_to'] } }),
    ),
  ).toEqual({ kind: 'dateRange' });
  expect(
    exportRejected(error({ code: 20001, httpStatus: 400, data: { fields: ['user_id'] } })),
  ).toEqual({ kind: 'failed' });
});
