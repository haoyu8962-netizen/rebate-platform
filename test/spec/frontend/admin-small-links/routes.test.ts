// @vitest-environment jsdom
// F1-08fe 预填地址（任务范围 ②③，只改读取查询参数的部分）：余额流水 /ledger?user_id=…&ref=…、提现审核
// /withdrawals?user_id=…，参数名同各自列表接口的查询参数（adminListLedgerEntries user_id / ref，
// listAdminWithdrawals user_id）。
import { expect, it } from 'vitest';
import {
  ledgerRoute,
  prefillFromSearch,
  type LedgerPrefill,
} from '../../../../apps/admin/src/pages/ledger/prefill.ts';
import {
  EMPTY_DRAFT,
  draftFromSearch,
} from '../../../../apps/admin/src/pages/withdrawals/model.ts';
import { userWithdrawalsRoute } from '../../../../apps/admin/src/pages/withdrawals/prefill.ts';
import { CONSOLE } from './fixtures.ts';

const USER = 'c1000003-0000-4000-8000-000000000003';
const ADJUST_ID = 'ad200001-0000-4000-8000-000000000001';

/** A console address split into its path and its query parameters (each name once). */
function parts(address: string): { pathname: string; params: Record<string, string> } {
  expect(address.startsWith('/'), `${address} is a console path`).toBe(true);
  const url = new URL(address, CONSOLE);
  const names = [...url.searchParams.keys()];
  expect(new Set(names).size, `${address} names each parameter once`).toBe(names.length);
  expect(url.hash).toBe('');
  return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
}

it('[AC-F1-08fe-ROUTE#1] 余额流水预填地址：/ledger 只带 user_id，有业务单号时另带 ref，不带别的参数', () => {
  expect(parts(ledgerRoute({ userId: USER }))).toEqual({
    pathname: '/ledger',
    params: { user_id: USER },
  });
  expect(parts(ledgerRoute({ userId: USER, ref: ADJUST_ID }))).toEqual({
    pathname: '/ledger',
    params: { user_id: USER, ref: ADJUST_ID },
  });
});

it('[AC-F1-08fe-ROUTE#2] 余额流水预填地址按 URL 编码：含 & = # 空格、中文与冒号的业务单号原样读回', () => {
  const ref = 'taobao:3891234567890-01 & x=1 #2 退款';
  expect(parts(ledgerRoute({ userId: USER, ref }))).toEqual({
    pathname: '/ledger',
    params: { user_id: USER, ref },
  });
});

it('[AC-F1-08fe-ROUTE#3] 从地址取预填：user_id 与 ref 去首尾空白；没有用户或用户为空白时不预填；空白的 ref 不带；其余参数不取', () => {
  expect(prefillFromSearch(`?user_id=${USER}&ref=${ADJUST_ID}`)).toEqual({
    userId: USER,
    ref: ADJUST_ID,
  });
  // toEqual: a left-out ref and ref: undefined are the same prefill; a blank ref is never ''.
  expect(prefillFromSearch(`?user_id=${USER}`)).toEqual({ userId: USER });
  expect(prefillFromSearch(`?user_id=${USER}`)?.ref).toBeUndefined();
  expect(prefillFromSearch(`?user_id=%20${USER}%20&ref=%20${ADJUST_ID}%20`)).toEqual({
    userId: USER,
    ref: ADJUST_ID,
  });
  expect(prefillFromSearch(`?user_id=${USER}&ref=%20%20`)?.ref).toBeUndefined();
  expect(prefillFromSearch(`?user_id=${USER}&ref=%20%20`)).toEqual({ userId: USER });
  expect(prefillFromSearch(`?page=3&ledger_type=REWARD&user_id=${USER}`)).toEqual({
    userId: USER,
  });
  expect(prefillFromSearch('')).toBeUndefined();
  expect(prefillFromSearch(`?ref=${ADJUST_ID}`)).toBeUndefined();
  expect(prefillFromSearch('?user_id=%20%20')).toBeUndefined();
});

it('[AC-F1-08fe-ROUTE#4] 预填地址与读取互逆：按地址读回的就是带过去的用户与业务单号', () => {
  const samples: LedgerPrefill[] = [
    { userId: USER },
    { userId: USER, ref: ADJUST_ID },
    { userId: USER, ref: 'bd000001-0000-4000-8000-000000000001' },
    { userId: USER, ref: 'taobao:3891234567890-01 & x=1 #2 退款' },
  ];
  for (const sample of samples) {
    const { search } = new URL(ledgerRoute(sample), CONSOLE);
    expect(prefillFromSearch(search)).toEqual(sample);
  }
});

it('[AC-F1-08fe-ROUTE#5] 提现审核按用户筛选的地址：/withdrawals 只带 user_id', () => {
  expect(parts(userWithdrawalsRoute(USER))).toEqual({
    pathname: '/withdrawals',
    params: { user_id: USER },
  });
});

it('[AC-F1-08fe-ROUTE#6] 提现审核从地址取起始筛选：user_id 预填「用户 ID」，可与工作台卡片的 status 同时带；按【去处理提现单】的地址读回该用户', () => {
  expect(draftFromSearch(`?user_id=${USER}`)).toEqual({ ...EMPTY_DRAFT, userId: USER });
  expect(draftFromSearch(`?status=PENDING_REVIEW&user_id=${USER}`)).toEqual({
    ...EMPTY_DRAFT,
    status: 'PENDING_REVIEW',
    userId: USER,
  });
  const { search } = new URL(userWithdrawalsRoute(USER), CONSOLE);
  expect(draftFromSearch(search)).toEqual({ ...EMPTY_DRAFT, userId: USER });
});
