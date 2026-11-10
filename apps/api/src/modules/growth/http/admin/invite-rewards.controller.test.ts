import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import type {
  AdminInviteRewardQuery,
  AdminInviteRewardsReader,
} from '../../application/admin-invite-rewards.ts';
import { AdminInviteRewardsController } from './invite-rewards.controller.ts';

const APP = 'invite_rewards_unit';
const INVITEE = '019c0000-0000-7000-8000-000000000002';

class RecordingGuard extends AdminOperationGuard {
  readonly inputs: AdminOperationInput[] = [];
  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.inputs.push(input);
    return business({ adminId: 'a', appId: APP, isSuper: false, loginName: 'a' });
  }
}

const BUDGET = {
  today: { date: '2026-11-25', granted_fen: 0 },
  total: { reserved_fen: 0, granted_fen: 0 },
};

function stubReader(seen: unknown[]): AdminInviteRewardsReader {
  return {
    async list(appId: string, query: AdminInviteRewardQuery) {
      seen.push({ appId, query });
      if (query.qualified_from === 'late') {
        return { kind: 'invalid', fields: ['qualified_from', 'qualified_to'] };
      }
      return { items: [], page: query.page, page_size: query.page_size, total: 0, budget: BUDGET };
    },
    async get(appId: string, inviteeId: string) {
      seen.push({ appId, inviteeId });
      return null;
    },
  };
}

function reply() {
  const headers: Record<string, string> = {};
  return {
    headers,
    header(name: string, value: string) {
      headers[name] = value;
    },
  };
}

it('[AC-B2-16d#u5] 列表：fund.view 只读、no-store、App 取自登录者，默认第 1 页 20 条', async () => {
  const guard = new RecordingGuard();
  const seen: unknown[] = [];
  const controller = new AdminInviteRewardsController(guard, stubReader(seen));
  const r = reply();
  const page = await controller.list({ id: 'trace-1' } as never, { status: 'qualified' }, r);
  expect(page).toEqual({
    code: 0,
    msg: '',
    trace_id: 'trace-1',
    data: { items: [], page: 1, page_size: 20, total: 0, budget: BUDGET },
  });
  expect(r.headers['Cache-Control']).toBe('no-store');
  expect(seen).toEqual([{ appId: APP, query: { status: 'qualified', page: 1, page_size: 20 } }]);
  expect(guard.inputs.map((i) => [i.permission, i.readOnly])).toEqual([['fund.view', true]]);
});

it('[AC-B2-16d#u6] 列表拒绝的字段 → 20001 data.fields；详情无记录 → 404 / 30701', async () => {
  const guard = new RecordingGuard();
  const controller = new AdminInviteRewardsController(guard, stubReader([]));
  const refused = await controller
    .list({ id: 'trace-2' } as never, { qualified_from: 'late' }, reply())
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HttpException);
  expect((refused as HttpException).getStatus()).toBe(400);
  expect((refused as HttpException).getResponse()).toMatchObject({
    code: 20001,
    data: { fields: ['qualified_from', 'qualified_to'] },
    trace_id: 'trace-2',
  });
  const missing = await controller
    .detail({ id: 'trace-3' } as never, INVITEE, reply())
    .catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(HttpException);
  expect((missing as HttpException).getStatus()).toBe(404);
  expect((missing as HttpException).getResponse()).toEqual({
    code: 30701,
    msg: '内容不存在或已下线',
    trace_id: 'trace-3',
  });
  expect(guard.inputs.map((i) => [i.permission, i.readOnly])).toEqual([
    ['fund.view', true],
    ['fund.view', true],
  ]);
});

it('[AC-B2-16d#u7] 没有数据库时读取失败关闭（抛错，由全局转 50001）', async () => {
  const controller = new AdminInviteRewardsController(new RecordingGuard(), null);
  await expect(controller.detail({ id: 't' } as never, INVITEE, reply())).rejects.toThrow(
    'need the database',
  );
});
