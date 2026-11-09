import type { Schema } from '@couli/contracts-ts';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import { AdminUsers } from '../../application/admin-users.ts';
import { AdminUsersController } from './users.controller.ts';

const DETAIL = {
  user_id: 'u1',
  risk: { state: 'frozen', reason: '内部说明' },
} as unknown as Schema<'AdminUserDetail'>;
const PAGE = { items: [], page: 1, page_size: 20, total: 0 } as Schema<'AdminUserPage'>;

class RecordingGuard extends AdminOperationGuard {
  readonly inputs: AdminOperationInput[] = [];
  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.inputs.push(input);
    return business({ adminId: 'a', appId: 'app', isSuper: false, loginName: 'a' });
  }
}

class StubUsers extends AdminUsers {
  constructor() {
    super(null, null);
  }
  override async list(): Promise<Schema<'AdminUserPage'>> {
    return PAGE;
  }
  override async lookup(): Promise<Schema<'AdminUserDetail'>> {
    return DETAIL;
  }
  override async detail(): Promise<Schema<'AdminUserDetail'>> {
    return DETAIL;
  }
}

const reply = { header: () => undefined };
const request = { id: 'trace' } as never;

it('[AC-B1-10o#131] lookup 与详情向守卫要权限点并按结果置空，放行点不变；列表不要权限点', async () => {
  const guard = new RecordingGuard();
  const controller = new AdminUsersController(guard, new StubUsers());
  const blanked = { state: 'frozen', reason: null };
  expect((await controller.lookup(request, { uid: 'u1' }, reply)).data.risk).toEqual(blanked);
  expect((await controller.detail(request, 'u1', reply)).data.risk).toEqual(blanked);
  await controller.list(request, {}, reply);
  expect(guard.inputs.map((i) => [i.permission, i.readOnly, i.withPermissions])).toEqual([
    ['user.lookup', true, true],
    [['user.list', 'user.lookup'], true, true],
    ['user.list', true, false],
  ]);
});
