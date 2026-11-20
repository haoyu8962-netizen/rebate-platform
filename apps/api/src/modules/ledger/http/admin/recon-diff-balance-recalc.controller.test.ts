// B2-02x unit tests (no database, no listen): the recalculation controller asks the guard for
// fund.recon with operation fund.recon.balance_recalc (sms tier), hands the guard the code of the
// answer (only code 0 spends the step-up token) and writes the answer on the raw reply; without its
// dependencies it fails inside the guard (50001). The use case is replaced here.
import { expect, it, vi } from 'vitest';
import type {
  AdminActor,
  AdminOperationGuard,
  AdminOperationInput,
  AdminOperationResponse,
} from '../../../platform/index.ts';
import type { BalanceRecalcDeps } from '../../application/admin-recon-diff-balance-recalc-use-case.ts';
import {
  AdminReconDiffBalanceRecalcController,
  type AdminReconDiffBalanceRecalcReply,
  type AdminReconDiffBalanceRecalcRequest,
} from './recon-diff-balance-recalc.controller.ts';

const answer = vi.hoisted(() => ({
  status: 400,
  envelope: {
    code: 20001,
    msg: '参数校验失败',
    data: { fields: ['recon_diff_id'] },
    trace_id: 't',
  },
  calls: [] as unknown[][],
}));

vi.mock('../../application/admin-recon-diff-balance-recalc-use-case.ts', () => ({
  recalcBalanceAdminReconDiff: vi.fn((...args: unknown[]) => {
    answer.calls.push(args);
    return Promise.resolve({ status: answer.status, envelope: answer.envelope });
  }),
}));

const ACTOR: AdminActor = {
  adminId: 'admin-1',
  appId: 'app_unit',
  isSuper: false,
  loginName: 'unit',
};

function guard(seen: { input?: AdminOperationInput; response?: AdminOperationResponse }) {
  return {
    async run(input, business) {
      seen.input = input;
      seen.response = await business(ACTOR);
      return seen.response;
    },
  } as AdminOperationGuard;
}

function reply() {
  const sent: { status?: number; type?: string; body?: string } = {};
  const raw: AdminReconDiffBalanceRecalcReply = {
    code(statusCode) {
      sent.status = statusCode;
      return raw;
    },
    type(contentType) {
      sent.type = contentType;
      return raw;
    },
    send(payload) {
      sent.body = payload;
      return undefined;
    },
  };
  return { raw, sent };
}

const REQUEST = { id: 'trace-9', ip: '10.0.0.1' } as unknown as AdminReconDiffBalanceRecalcRequest;

it('[AC-B2-02x-UNIT#17] 守卫取 fund.recon + fund.recon.balance_recalc（短信档）；用例得到守卫给的应用与账号、请求的 IP 与 trace；应答原样写回，守卫读到同一个 code', async () => {
  const seen: { input?: AdminOperationInput; response?: AdminOperationResponse } = {};
  const controller = new AdminReconDiffBalanceRecalcController(
    guard(seen),
    {} as BalanceRecalcDeps,
  );
  const { raw, sent } = reply();
  await controller.recalc(REQUEST, 'diff-1', { reason: '核对' }, raw);
  expect(seen.input).toMatchObject({
    request: REQUEST,
    permission: 'fund.recon',
    operation: 'fund.recon.balance_recalc',
  });
  expect(seen.input?.readOnly).toBeUndefined();
  expect(answer.calls[0]?.slice(1)).toEqual([
    { appId: 'app_unit', adminId: 'admin-1', ip: '10.0.0.1' },
    'diff-1',
    { body: { reason: '核对' }, traceId: 'trace-9' },
  ]);
  expect(seen.response).toEqual({ statusCode: 400, body: answer.envelope });
  expect(sent).toEqual({
    status: 400,
    type: 'application/json; charset=utf-8',
    body: JSON.stringify(answer.envelope),
  });
});

it('[AC-B2-02x-UNIT#18] 没有依赖（无库、无事件总线或恢复钩子）→ 在守卫内抛出，不写应答', async () => {
  const seen: { input?: AdminOperationInput; response?: AdminOperationResponse } = {};
  const controller = new AdminReconDiffBalanceRecalcController(guard(seen), null);
  const { raw, sent } = reply();
  await expect(controller.recalc(REQUEST, 'diff-1', { reason: '核对' }, raw)).rejects.toThrow(
    /needs the database/,
  );
  expect(sent).toEqual({});
});
