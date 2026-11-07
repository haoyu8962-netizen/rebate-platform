// B1-28p: the feedback module (S-15 product feedback; 规划/02 §4.1: feedback is the single writer of
// app.product_feedbacks). Loaded by app.module on the api entry only, beside identity and risk,
// whose request checks (signature, token, app source), version gate and idempotency post-miss hooks
// run before the route. The composition root passes content's shared configuration reader and
// linking's read of app.links; feedback imports neither module.
// Nest metadata is applied without decorator syntax (the index is reachable from the test project).
import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { CLOCK, DB, type Clock } from '../platform/index.ts';
import type { FeedbackAccountReader, FeedbackLinkReader } from './application/submit.ts';
import {
  ADMIN_PRODUCT_FEEDBACKS_DB,
  AdminProductFeedbacksController,
} from './http/admin/product-feedbacks.controller.ts';
import {
  FEEDBACK_ROUTE,
  FeedbackController,
  type FeedbackConfigReader,
  type FeedbackRoutePorts,
} from './http/public/feedback.controller.ts';

export interface FeedbackModuleOptions {
  /** content's configuration reader, one per process (feedback.enabled, the daily limit). */
  readonly config: (db: Kysely<Database>, clock: Clock) => FeedbackConfigReader;
  /** linking's read of app.links (existence in the app), on the handle it is given. */
  readonly links: FeedbackLinkReader;
  /** identity's deletion status of the submitting account (money r1 S1, BR-ID-28). */
  readonly accounts: FeedbackAccountReader;
}

export class FeedbackModule {
  static forApi(options: FeedbackModuleOptions): DynamicModule {
    return {
      module: FeedbackModule,
      controllers: [FeedbackController],
      providers: [
        {
          provide: FEEDBACK_ROUTE,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
          ): FeedbackRoutePorts | null =>
            db === undefined
              ? null
              : {
                  config: options.config(db, clock),
                  links: options.links,
                  accounts: options.accounts,
                },
        },
      ],
    };
  }
}

Module({})(FeedbackModule);

/**
 * B1-28s: GET /admin/v1/product-feedbacks (adminListProductFeedbacks, feedback.view, read only).
 * Loaded by app.module on the admin entry only; the AdminOperationGuard comes from the admin auth
 * module on that entry. Without a database the route registers and fails closed (50001).
 */
export class FeedbackAdminModule {
  static forAdmin(): DynamicModule {
    return {
      module: FeedbackAdminModule,
      controllers: [AdminProductFeedbacksController],
      providers: [
        {
          provide: ADMIN_PRODUCT_FEEDBACKS_DB,
          inject: [{ token: DB, optional: true }],
          useFactory: (db: Kysely<Database> | undefined): Kysely<Database> | null => db ?? null,
        },
      ],
    };
  }
}

Module({})(FeedbackAdminModule);
