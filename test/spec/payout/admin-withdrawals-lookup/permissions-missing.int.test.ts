// B2-09zg rule test (claude-independent, SPEC_REF 39756e36; 编排 2026-11-08 18:53): AdminActor.permissions
// is read only for blanking and never decides who is let in (that stays the guard's permission
// check). A controller that gets no `permissions` (undefined) treats the account as only holding
// user.lookup and blanks the internal fields (D10-1042: rather too little than too much); a super
// admin holds every point and is not blanked. Top-level it() only (规划/11 §4.3).
//
// The controller is built directly with a guard double (lets the call through, hands over the
// actor) and the real reads: PostgreSQL as couli_app, identity's masked phones. Only `list` is
// called: its signature is the same before and after the implementation.
//
// Red on the code before this task: the controller blanks nothing, so the actor without
// `permissions` reads the real values and the first comparison fails.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMaskedPhoneReader } from '../../../../apps/api/src/modules/identity/ports/masked-phones.ts';
import type {
  AdminWithdrawalListQuery,
  AdminWithdrawalReadDeps,
} from '../../../../apps/api/src/modules/payout/application/admin-withdrawals.ts';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  REVIEW,
  fixture,
  listView,
  normalize,
  seedMember,
  seedWithdrawal,
  suite,
  type Page,
} from '../admin-withdrawals/kit.ts';
import { FLAG_CODE, NOTE_MARK, blankedRow, richSeed, withLookupAdmin } from './kit.ts';

const s = suite();

/** The actor as this task's guard hands it over; `permissions` may be absent. */
type HandedActor = Omit<AdminActor, 'permissions'> & {
  readonly permissions?: readonly string[];
};

/** What differs between the actors of the case. */
type Access = Pick<HandedActor, 'isSuper' | 'permissions'>;

/** Lets every call through and hands `actor` to the business callback. */
class PassingGuard extends AdminOperationGuard {
  readonly #actor: HandedActor;

  constructor(actor: HandedActor) {
    super();
    this.#actor = actor;
  }

  override run(
    _input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    return business(this.#actor as AdminActor);
  }
}

interface ListController {
  list(
    request: { readonly id: string },
    query: AdminWithdrawalListQuery,
    reply: { header(name: string, value: string): unknown },
  ): Promise<{ readonly code: number; readonly data: Page }>;
}

it('[AC-B2-09zg#10] 提现单列表（控制器直调）：guard 交来的 actor 没有 permissions 且不是超管 → 按只持 user.lookup 处理，每行 reject_note、auto_decision 为 null，risk_flags 为 []（库里都有真实值），金额、status 等其余字段照常；对照：超管不带 permissions、带 permissions=[withdraw.review] 的账号读到真实值', async () => {
  // URL import follows the rule-test convention for decorated API controllers (the test project
  // compiles erasable syntax only).
  const { AdminWithdrawalsController } = (await import(
    new URL(
      '../../../../apps/api/src/modules/payout/http/admin/withdrawals.controller.ts',
      import.meta.url,
    ).href
  )) as {
    AdminWithdrawalsController: new (
      guard: AdminOperationGuard,
      deps: AdminWithdrawalReadDeps,
    ) => ListController;
  };
  const f = fixture(s);
  await withLookupAdmin(f, async (h) => {
    const member = await seedMember(f, h);
    const older = await seedWithdrawal(f, h, member, richSeed(f, 60));
    const newer = await seedWithdrawal(f, h, member, richSeed(f, 30));
    const real = [newer, older].map((row) => listView(row, member));
    for (const view of real) {
      expect(view).toMatchObject({
        reject_note: NOTE_MARK,
        auto_decision: { result: 'manual' },
        risk_flags: [{ code: FLAG_CODE }],
      });
    }

    const phones = createMaskedPhoneReader(f.db, h.crypto);
    const deps: AdminWithdrawalReadDeps = {
      db: f.db,
      now: () => f.clock.now(),
      phones: (appId, userIds) => phones.maskedPhones(appId, userIds),
      // Only the detail decrypts a payee.
      decryptPayee: () => {
        throw new Error('the list never decrypts a payee');
      },
    };
    const read = async (access: Access) => {
      const actor: HandedActor = {
        adminId: randomUUID(),
        appId: f.appId,
        loginName: 'synthetic_admin',
        ...access,
      };
      const controller = new AdminWithdrawalsController(new PassingGuard(actor), deps);
      const response = await controller.list(
        { id: randomUUID() },
        { user_id: member.userId },
        { header: () => undefined },
      );
      expect(response.code).toBe(0);
      expect(response.data.total).toBe(2);
      return response.data.items.map(normalize);
    };

    expect(await read({ isSuper: false })).toEqual(real.map(blankedRow));
    expect(await read({ isSuper: true })).toEqual(real);
    expect(await read({ isSuper: false, permissions: [REVIEW] })).toEqual(real);
  });
});
