// The port through which every business module guards its admin operations (F1-06u; 02 §4.1
// 「各业务模块的后台接口在各自模块的 `http/admin/` 下，由本模块统一挂载守卫」; 04 §11; 08 BR-ID-34).
// Business modules must not import admin (admin depends on every module), so the port lives here,
// like the audit port: the abstract class is also the Nest injection token. The admin module
// implements it and provides it globally on the admin entry only; the api and stream entries do
// not provide it.
//
// Also compiled by the `test` project: erasable syntax only, no NestJS, no `process.env`.

/** Trusted identity handed to a business module after its admin operation is authorised. */
export interface AdminActor {
  readonly adminId: string;
  readonly appId: string;
  readonly isSuper: boolean;
  /** admin_users.login_name as read for this very request. */
  readonly loginName: string;
  /**
   * The points ticked for the account as read for this very request (a super admin's as stored,
   * possibly none). Present only when the operation set `withPermissions`; a test double may leave
   * it out. Read only to narrow what is shown, never to let anyone in (the guard's point check).
   */
  readonly permissions?: readonly string[];
}

export interface AdminOperationInput {
  /** The Fastify request: its verified admin principal, X-Step-Up-Token header and id (trace_id). */
  readonly request: object;
  /**
   * Permission key of specs/permissions.yaml, or a non-empty list of keys of which the account
   * must hold any one (F1-10c). A list on a write must share one step-up tier; an empty list or
   * a write list of differing tiers is a programming error (50001).
   */
  readonly permission: AdminPermissionSelector;
  /** Operation under the permission, when its step-up tier departs from the permission's. */
  readonly operation?: string;
  /**
   * A read-only operation (F1-10c): holding the point (any one of the list) is enough; no
   * step-up is required and X-Step-Up-Token is neither read nor consumed. Default false.
   */
  readonly readOnly?: boolean;
  /** Hand the account's points to `business` as actor.permissions (B2-09zg). Default false. */
  readonly withPermissions?: boolean;
}

/** One permission key, or a list of keys of which any one suffices (F1-10c). */
export type AdminPermissionSelector = string | readonly string[];

export interface AdminOperationResponse {
  readonly statusCode: number;
  readonly body: { readonly code: number; readonly data?: unknown };
}

/**
 * Checks, in order: the verified admin principal (none → 50001, a programming error), the account
 * re-read (missing or not active → 10001), the permission point (10403), the step-up tier
 * (10003); then runs `business` and consumes the step-up token only after HTTP 2xx with code 0.
 * Rejections are thrown as error envelopes for the global error handling; a failing database or
 * Redis ends as 50001, never as an allowed operation.
 */
export abstract class AdminOperationGuard {
  abstract run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse>;
}
