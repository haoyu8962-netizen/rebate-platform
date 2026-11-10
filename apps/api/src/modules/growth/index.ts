// growth module public surface (B1-11b): change-log writers and as-of readers; other modules import
// only from here. B1-11e: the Nest module with POST /v1/me/inviter, assembled by app.module.
export { GrowthModule } from './growth.module.ts';
export type { GrowthModuleOptions } from './growth.module.ts';
// B2-16d: the console's invite reward reads (GET /admin/v1/invite-rewards[/{invitee_id}]), admin entry.
export { GrowthAdminModule } from './growth-admin.module.ts';
export type { GrowthAdminModuleOptions } from './growth-admin.module.ts';
export { createAdminInviteRewardsReader } from './application/admin-invite-rewards.ts';
export type {
  AdminInviteRewardsReader,
  InviteRewardPhoneReader,
} from './application/admin-invite-rewards.ts';
// B1-35: the invite reward campaign (BR-INV-24): qualification, budget port, trigger, payout,
// daily expiry, scanner and the worker loop.
export {
  createInviteRewardQualifier,
  createInviteRewardBudgetReader,
  createInviteRewardTrigger,
  createInviteRewardPayout,
  createInviteRewardExpiry,
  createInviteRewardScanner,
  startInviteRewardWorker,
  inviteRewardScannerToken,
  INVITE_REWARD_SCAN_INTERVAL_MS,
} from './application/invite-reward.ts';
export type {
  InviteRewardScanner,
  InviteRewardPayoutDeps,
  InviteRewardBaseDeps,
  InviteRewardOrderFacts,
  InviteRewardOrder,
  InviteRewardGrantWriter,
  InviteRewardQualifier,
  InviteRewardPayout,
  InviteRewardExpiry,
  InviteRewardTrigger,
} from './application/invite-reward.ts';
export { appendLevelChange, appendRelationChange } from './infra/change-logs.ts';
export { detachChildrenOfDeleted } from './application/detach-children-of-deleted.ts';
export { createGrowthHistory } from './infra/history.ts';
// B1-11d: every write that changes users.parent_id takes this app-level lock first.
export {
  RELATION_WRITE_LOCK_NAMESPACE,
  lockRelationWrites,
  relationWriteLockKey,
} from './infra/relation-lock.ts';
export type {
  AsOfQuery,
  LevelAt,
  LevelChangeInput,
  LevelChangeSource,
  RelationChangeInput,
  RelationChangeSource,
  UserLevel,
} from './domain/change-logs.ts';
export type { GrowthExecutor, GrowthHistory, GrowthHistoryOptions } from './infra/history.ts';
export { createParentRelationReader } from './ports/parent-relation.ts';
export { createFirstAppLoginReview } from './application/first-app-login-review.ts';
export type {
  FirstAppLoginReviewDeps,
  LandingLoginReview,
  LandingLoginReviewInput,
} from './application/first-app-login-review.ts';
export type {
  ParentRelation,
  ParentRelationReader,
  ParentRelationReaderOptions,
  ParentRelationSubject,
} from './ports/parent-relation.ts';
export {
  createInviteBinder,
  createRegistrationInviteBinding,
} from './application/invite-binder.ts';
export type {
  InviteBindCommand,
  InviteBindOptions,
  InviteBinder,
  InviteBinderDeps,
  InviteBindingResult,
  InviteSubject,
  InviteActivityReader,
  RegistrationInviteBinding,
  RegistrationInviteInput,
} from './application/invite-binder.ts';
// B1-11h: the landing channel (precheck before the SMS code, binding in identity's transaction).
export { createLandingInviteBinder, INVITE_FAIL_IP_CONTEXT } from './application/landing-binder.ts';
export type {
  LandingBindInput,
  LandingBindResult,
  LandingInviteBinder,
  LandingInviteBinderDeps,
  LandingPrecheckInput,
  LandingPrecheckResult,
} from './application/landing-binder.ts';
// B1-11j: the invite page read behind GET /v1/invites/me, assembled by app.module.
export { createMyInviteReader, firstShareDomain } from './application/my-invite.ts';
export type {
  MyInvite,
  MyInviteDeps,
  MyInviteReader,
  MyInviteResult,
} from './application/my-invite.ts';
// B1-27f: the invite section of a personal information copy (only whether an inviter is bound).
export { readPersonalDataCopyInvite } from './application/personal-data-copy-read.ts';
export type {
  PersonalDataCopyInviteRow,
  PersonalDataCopyInviteSubject,
} from './application/personal-data-copy-read.ts';
