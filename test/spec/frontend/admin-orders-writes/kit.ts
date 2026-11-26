import { screen, within } from '@testing-library/dom';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { VERIFY } from '../admin-kill-switches/fixtures.ts';
import {
  DETAIL,
  createServer,
  detail,
  failure,
  ok,
  type Detail,
  type Server,
} from '../admin-orders/orders-fixtures.ts';

export { VERIFY };
export const STEP_UP_TITLE = '二次验证 · 动态码';
export const STEP_UP_TOKEN = 'orders-test-totp';
export const NOTE = '已经核对，登记本次处理';
export const ASSIGN_REASON = '凭购物凭证核实订单归属';
export const TARGET = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c02';

export const ENTRY = {
  hold: '暂停结算',
  unhold: '恢复结算',
  'reason-sub': '原因细分',
  reassign: '指定归属',
} as const;

export type Action = keyof typeof ENTRY;
type Entry = (typeof ENTRY)[Action];
const WRITE_ENTRY =
  /导入维权|导入违规|暂停结算|恢复结算|原因细分|改子原因|指定归属|更改归属|改归属|改派|重新分佣|手动锁定|导出|查看金额变更记录/;

export function entryName(action: Entry): RegExp {
  return new RegExp(`^${action}(?:$|\\s|[（(·：:])`);
}

export function controls(scope: HTMLElement, name: RegExp): HTMLElement[] {
  return [
    ...within(scope).queryAllByRole('button', { name }),
    ...within(scope).queryAllByRole('link', { name }),
  ];
}

/** The four order writes and the existing guards for other unconnected actions. */
export function expectWriteEntries(server: Server, expected: readonly Entry[]): void {
  const main = screen.getByRole('main');
  const actual = Object.values(ENTRY).flatMap((name) =>
    controls(main, entryName(name)).map(() => name),
  );
  expect(actual.sort()).toEqual([...expected].sort());
  expect(controls(main, WRITE_ENTRY)).toHaveLength(expected.length);
  expect(main.textContent).not.toContain('原始报文');
  expect(writes(server)).toEqual([]);
}

export function order(patch: Partial<Detail> = {}): Detail {
  return detail({
    platform_status: 'RECEIVED',
    rebate_status: 'WAITING',
    display_status: 'WAITING',
    reason: 'REFUND',
    reason_sub: 'IN_SALE',
    row_version: 19,
    credited_at: null,
    status_history: [],
    flags: { locked: false, status_locked: false, rights_pending: false, hold: false },
    ...patch,
  });
}

export function unattributed(patch: Partial<Detail> = {}): Detail {
  return order({
    user: null,
    user_basis: null,
    rebate_status: 'UNATTRIBUTED',
    display_status: null,
    commission_split: null,
    reason: null,
    reason_sub: null,
    ...patch,
  });
}

export function assigned(shown: Detail): Detail {
  return {
    ...shown,
    user: { user_id: TARGET, phone_masked: '137****4321' },
    user_basis: 'admin',
    flags: { ...shown.flags, locked: true },
    rebate_status: 'WAITING',
    row_version: 38,
  };
}

export function held(shown: Detail): Detail {
  return {
    ...shown,
    flags: { ...shown.flags, hold: true },
    hold_reason: 'RISK',
    display_status: 'REVIEWING',
    row_version: 36,
    last_hold_by_name: '测试运营甲',
    last_hold_note: '服务端返回的最新暂停备注',
  };
}

export function released(shown: Detail): Detail {
  return {
    ...shown,
    flags: { ...shown.flags, hold: false },
    hold_reason: null,
    display_status: 'WAITING',
    row_version: 54,
  };
}

export function path(action: Action): string {
  return `${DETAIL}/${action}`;
}

export function createWriteServer(shown: Detail) {
  const server = createServer(undefined, shown);
  return Object.assign(server, {
    respond(action: Action, reply: Parameters<Server['once']>[2]) {
      server.once('POST', path(action), reply);
    },
    succeed(action: Action, updated: Detail) {
      // The GET fixture stays stale so it cannot stand in for the POST response.
      server.once('POST', path(action), () => ok(updated));
    },
    verifyTotp() {
      server.once('POST', VERIFY, ({ body }) => {
        const code = body as Partial<Schema<'AdminStepUpRequest'>> | undefined;
        if (code?.tier !== 'totp' || code.code !== '123456') return failure(20002);
        return ok({
          tier: 'totp',
          step_up_token: STEP_UP_TOKEN,
          expire_at: '2099-01-01T00:00:00Z',
        });
      });
    },
  });
}

export function writes(server: Server) {
  return server.log.filter(({ method }) => method !== 'GET' && method !== 'HEAD');
}

export function expectOrderPosts(
  server: Server,
  action: Action,
  body: unknown,
  tokens: readonly (string | null)[] = [null],
): void {
  const requests = writes(server).filter((request) => request.path !== VERIFY);
  const actual = requests.map((request) => ({
    method: request.method,
    path: request.path,
    body: request.body,
    token: request.headers.get('X-Step-Up-Token'),
    key: request.headers.get('Idempotency-Key'),
  }));
  const expected = tokens.map((token) => ({
    method: 'POST',
    path: path(action),
    body,
    token,
    key: null,
  }));
  expect(actual).toEqual(expected);
}

export function assignBody(
  shown: Detail,
  reason = ASSIGN_REASON,
): Schema<'AdminOrderReassignRequest'> {
  return {
    user_id: TARGET,
    expected_user_id: null,
    expected_locked: shown.flags.locked,
    reason,
  };
}
