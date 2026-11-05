// Public surface of the notification module. Other modules import only from this file.
// B1-22b: site union authorization alerts (BR-ID-24 ②, BR-TEXT-20): union's monitor plans them on
// its own transaction; the worker's union-auth queue delivers them.
export {
  createSiteAuthAlertPort,
  createFakeTemplateSmsSender,
  createTemplateSmsSender,
} from './site-auth-alert/service.ts';
export type {
  SiteAuthAlertPlan,
  SiteAuthAlertPort,
  SiteAuthAlertOptions,
  TemplateSmsSender,
  TemplateSmsMessage,
  TemplateSmsResult,
  TemplateSmsQueryResult,
  FakeTemplateSmsSender,
  SiteAuthPendingAlerts,
} from './site-auth-alert/service.ts';
// B1-12b: the push token commands of a session's start and end (BR-ID-07). identity never imports
// them: app.module hands them to identity's push token port (dependency inversion).
export {
  bindPushTokensForSession,
  unbindPushTokensForSession,
} from './application/session-bindings.ts';
export type { SessionBinding, SessionUnbinding } from './application/session-bindings.ts';
// F1-02zzk: notification's deletion cleanup port (BR-ID-28 push tokens). identity never imports
// it: app.module hands it to identity's DeletionCleanupPorts.notification.
export { deletePushTokensForUser } from './application/deletion-cleanup.ts';
export type {
  PushTokenDeletionInput,
  PushTokenDeletionResult,
} from './application/deletion-cleanup.ts';
export { createPushTokenReporter } from './application/push-token-report.ts';
export type {
  PushTokenConfigReader,
  PushTokenReport,
  PushTokenReporter,
  PushTokenReporterOptions,
} from './application/push-token-report.ts';
export { PushTokenController } from './http/public/push-token.controller.ts';
export type { PushTokenHttpRequest } from './http/public/push-token.controller.ts';
export { createMessageReader } from './application/message-read.ts';
export type {
  InboxMessageView,
  MessageQuery,
  MessageReader,
  MessageReaderOptions,
} from './application/message-read.ts';
export { InboxCursorError, createInboxMessages } from './application/inbox-messages.ts';
export type {
  InboxListQuery,
  InboxMessages,
  InboxMessagesOptions,
  InboxOwner,
  InboxReadCommand,
} from './application/inbox-messages.ts';
export { MessagesController } from './http/public/messages.controller.ts';
export type { MessageHttpRequest } from './http/public/messages.controller.ts';
export { NotificationModule } from './notification.module.ts';
// B1-12m: GET / PUT /v1/me/notification-settings (getNotificationSettings /
// updateNotificationSettings): the caller's push switches per category (BR-WATCH-19 ③).
export { createNotificationSettings } from './application/notification-settings.ts';
export type {
  NotificationSettingsOptions,
  NotificationSettingsOwner,
  NotificationSettingsService,
} from './application/notification-settings.ts';
export { NotificationSettingsController } from './http/public/notification-settings.controller.ts';
export type { NotificationSettingsHttpRequest } from './http/public/notification-settings.controller.ts';
// B1-12o: the push sending core (inbox always, push per category switch and BR-ID-07 pre-send
// check) and the demonstration MobPush channel. Not wired to an event consumer yet: a consumer
// calls record() in its transaction and, after the commit, dispatch(db, event) — the only path
// to the push channel.
export { createPushSendCore } from './application/push-send.ts';
export type {
  PushCategory,
  PushDispatchOutcome,
  PushEvent,
  PushSendCore,
  PushSendInput,
  PushSendOptions,
} from './application/push-send.ts';
export type { PushDeliveryChannel, PushPayload, PushTarget } from './ports/push-delivery.ts';
export { createDemoMobPush } from './infra/demo-mobpush.ts';
// B1-12w: the entry's verification code sender on the Aliyun SendSms channel (D10-315). identity
// never imports it: app.module hands it to identity's SmsSender port.
export { createEntrySmsSender } from './sms/index.ts';
export type {
  EntrySmsSenderDeps,
  AliyunSmsFetch,
  VerifyCodeDelivery,
  VerifyCodeMessage,
  VerifyCodeSmsSender,
} from './sms/index.ts';
// B1-12y: the signature name and template CODE by code from notify_templates' SMS registration
// (D10-316 ①), and the site auth alert SMS on the real channel with its BizId in notify_logs.
export { createRegisteredTemplateResolver } from './sms/index.ts';
export type {
  RegisteredTemplateQuery,
  RegisteredTemplateResolver,
  RegisteredTemplateResolverDeps,
} from './sms/index.ts';
export { createLiveTemplateSmsSender } from './site-auth-alert/live-sender.ts';
export type { LiveTemplateSmsSenderDeps } from './site-auth-alert/live-sender.ts';
// B1-12z: the console's notification channel page (/admin/v1/notify-channels*, CT-24t) on the
// admin entry, and the entry's sender of the SMS registration test messages (app.module only).
export { NotificationAdminModule, isFundTemplateCode } from './notification-admin.module.ts';
export type { NotificationAdminOptions } from './notification-admin.module.ts';
export { createNotifySmsTestSender } from './admin-channels/live-test-sender.ts';
export type { NotifySmsTestSenderDeps } from './admin-channels/live-test-sender.ts';
export {
  createFakeNotifySmsTestSender,
  notifySmsTestSenderToken,
} from './admin-channels/sms-test-sender.ts';
export type {
  FakeNotifySmsTestSender,
  NotifySmsTestMessage,
  NotifySmsTestResult,
  NotifySmsTestSender,
} from './admin-channels/sms-test-sender.ts';
export type { NotifyVerifyPhones } from './admin-channels/service.ts';
// B1-15i: the DELETION_PROGRESS inbox message (BR-TEXT-23), written on identity's business
// transaction. identity never imports it: app.module hands it to identity's DeletionProgressNotice.
export {
  renderDeletionProgressMessage,
  writeDeletionProgressMessage,
} from './application/deletion-progress-message.ts';
export type {
  DeletionCancelledInput,
  DeletionCancelledNegativeInput,
  DeletionProgressInput,
  DeletionProgressMessage,
  DeletionProgressOverride,
  DeletionProgressVariant,
  DeletionProgressWriteOptions,
  DeletionRequestedInput,
} from './application/deletion-progress-message.ts';
// B2-12c: the BALANCE_ADJUSTED inbox message of a manual adjustment (BR-FUND-24 ⑦, BR-TEXT-19),
// written on ledger's adjustment transaction. ledger never imports it: app.module hands it over.
export { renderBalanceAdjustedMessage } from './application/balance-adjusted-message.ts';
export type {
  BalanceAdjustedFacts,
  BalanceAdjustedMessage,
  BalanceAdjustedOverride,
} from './application/balance-adjusted-message.ts';
export { recordBalanceAdjustedMessage } from './application/balance-adjusted-message-record.ts';
export type { BalanceAdjustedRecordInput } from './application/balance-adjusted-message-record.ts';
