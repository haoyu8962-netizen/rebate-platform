// The feedback module's only public entry (apps/api/AGENTS.md): product feedback
// (CT-26q submitProductFeedback, B1-28p) and its deletion cleanup step.
export { deleteFeedbackForUser } from './application/deletion.ts';
export type { FeedbackDeletionInput } from './application/deletion.ts';
// B1-28p: POST /v1/products/{product_key}/feedback, loaded by app.module on the api entry.
export { FeedbackModule } from './feedback.module.ts';
export type { FeedbackModuleOptions } from './feedback.module.ts';
export type { FeedbackAccountReader, FeedbackLinkReader } from './application/submit.ts';
export type { FeedbackConfigReader } from './http/public/feedback.controller.ts';
