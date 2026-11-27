// B2-05v (Codex money review r1 S1-2, D10-3619): the member controller's mapping of the
// application's answers to HTTP status and envelope. Tested on the controller class itself
// (createWithdrawal → the handler's applyResult → the thrown HttpException), without Nest, a
// database or a listening port: the idempotency port is a fake that runs the handler once on a
// placeholder transaction and answers what it returned (source 'handler'); the application use
// case is a fake answering a fixed result.
import type { DB } from '@couli/db';
import { HttpException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { HandlerResult, Idempotency, IdempotentResponse } from '../../../platform/index.ts';
import type {
  WithdrawApplyResult,
  WithdrawApplyService,
} from '../../application/withdraw-apply.ts';
import {
  WithdrawalsController,
  type CreateWithdrawalHttpRequest,
} from './withdrawals.controller.ts';

const TRACE_ID = 'trace-b2-05v-unit';

function controllerAnswering(result: WithdrawApplyResult) {
  const apply = vi.fn(async (): Promise<WithdrawApplyResult> => result);
  const service: WithdrawApplyService = { apply };
  const executeInTransaction = vi.fn(
    async (
      _request: unknown,
      handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
    ): Promise<IdempotentResponse> => {
      const answer = await handler({} as Transaction<DB>);
      return {
        status: answer.status,
        body: JSON.stringify(answer.envelope),
        source: 'handler',
      };
    },
  );
  const idempotency = { executeInTransaction } as unknown as Idempotency;
  return { controller: new WithdrawalsController(null, null, service, idempotency), apply };
}

const request = {
  id: TRACE_ID,
  headers: { 'idempotency-key': 'b2-05v-unit-key' },
  body: { amount_fen: 1000 },
  principal: {
    uid: '00000000-0000-7000-8000-000000000001',
    app_id: 'b2_05v_controller_unit',
    sid: 'session-1',
    device_id: 'device-1',
    scp: 'full',
  },
} as unknown as CreateWithdrawalHttpRequest;

async function refusal(result: WithdrawApplyResult): Promise<{ status: number; body: unknown }> {
  const { controller, apply } = controllerAnswering(result);
  const error: unknown = await controller.createWithdrawal(request).then(
    (): unknown => null,
    (thrown: unknown): unknown => thrown,
  );
  expect(apply).toHaveBeenCalledTimes(1);
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), body: http.getResponse() };
}

it('[AC-B2-05v#12-UNIT#1] 用例返回 50001：HTTP 500，code 50001，msg「服务端错误」，不带 data', async (): Promise<void> => {
  expect(await refusal({ code: 50001, data: {} })).toStrictEqual({
    status: 500,
    body: { code: 50001, msg: '服务端错误', trace_id: TRACE_ID },
  });
});

it('[AC-B2-05v#12-UNIT#2] 已登记的 3xxxx 码照旧：30305 → HTTP 422 与包内默认文案', async (): Promise<void> => {
  expect(await refusal({ code: 30305, data: {} })).toStrictEqual({
    status: 422,
    body: { code: 30305, msg: '请先绑定收款账号', trace_id: TRACE_ID },
  });
});

it('[AC-B2-05v#12-UNIT#3] 已登记的 403 码照旧：44001 → HTTP 403「操作未通过安全校验」', async (): Promise<void> => {
  expect(await refusal({ code: 44001, data: {} })).toStrictEqual({
    status: 403,
    body: { code: 44001, msg: '操作未通过安全校验', trace_id: TRACE_ID },
  });
});
