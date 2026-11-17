// F1-09f: the console's page configuration (/admin/v1/pages*; contract adminListPageConfigs …
// adminRollbackPageConfig; 04 §6.6 `pages`, §3.2; 编排者裁定 F1-09f 1–10, F1–F6).
// Reads: pages with at least one saved version, their version history, one version with sections.
// Writes (one transaction each): lock the page row FOR UPDATE (a draft save first creates it at
// revision 0), then 30701 (no saved version; draft saves excepted) → 20902 (revision ≠
// expected_revision, data.resource=page) → 20001 (state / sections); on success the page row's
// revision goes up by 1 and one audit row is appended in the same transaction. Any refusal throws,
// so the transaction rolls back, a first save's new row included.
// Saved sections are never changed; publish re-runs the save checks on the stored sections, with
// switch external_page.union_host_block read inside the transaction (not cached, F4).
// Permission checks are the controller's guard; app and admin come from the guard's actor.
//
// F1-09p scheduled publish (编排者裁定 9.2): publish with publish_at writes the page's one pending
// slot (version stays draft) and enqueues the due job in the same transaction; DELETE …/schedule
// clears it. A slot takes effect by time: every write applies a due slot on the locked row before
// its CAS (applyDueSchedule: the version published at the scheduled time by the scheduler, pointers
// as an immediate publish, revision + 1, no audit row, Y8 / Y9), in the same transaction, so a
// refused write rolls that back too; the reads apply it on the fly (../domain/pages/schedule.ts).
import type { Schema } from '@couli/contracts-ts';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  type PageVersionTransition,
  canChangePageVersion,
  pageVersionChange,
} from '../domain/pages/version-status.ts';
import {
  type PageSlot,
  effectivePage,
  isSchedulable,
  slotDelaySeconds,
} from '../domain/pages/schedule.ts';
import { instantOf } from './article-admin.ts';

export type PageView = Schema<'AdminPageConfig'>;
export type PageVersionView = Schema<'AdminPageConfigVersion'>;
export type PageVersionSummary = Schema<'AdminPageConfigVersionSummary'>;

export interface PageRow {
  readonly currentVersion: number | null;
  readonly grayVersion: number | null;
  readonly grayPercent: number;
  readonly revision: number;
  /** The pending scheduled publish (F1-09p), `by` the scheduling admin's id; null = none. */
  readonly slot: PageSlot | null;
}

export interface PageVersionRow {
  readonly version: number;
  readonly status: string;
  readonly sections: unknown;
}

export interface PageActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface PageListQuery {
  readonly page?: number;
  readonly page_size?: number;
}

export interface PagePointers {
  readonly currentVersion: number | null;
  readonly grayVersion: number | null;
  readonly grayPercent: number;
}

/** Reads with the login names of the admins joined in (P5); all scoped to one app. */
export interface PageConfigReads {
  pages(
    appId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: PageView[]; total: number }>;
  /** undefined when the page has no saved version (an empty lock row included). */
  page(appId: string, key: string): Promise<PageView | undefined>;
  versions(
    appId: string,
    key: string,
    offset: number,
    limit: number,
  ): Promise<{ items: PageVersionSummary[]; total: number }>;
  version(appId: string, key: string, version: number): Promise<PageVersionView | undefined>;
}

export interface PageConfigTx extends PageConfigReads {
  /** Raw value of config_items external_page.union_host_block (undefined = no row), unbuffered. */
  unionHostBlock(appId: string): Promise<unknown>;
  /** INSERT … ON CONFLICT DO NOTHING of a revision-0 page row. */
  ensurePage(appId: string, key: string, at: Date): Promise<void>;
  lock(appId: string, key: string): Promise<PageRow | undefined>;
  latestVersion(appId: string, key: string): Promise<number | null>;
  versionRow(appId: string, key: string, version: number): Promise<PageVersionRow | undefined>;
  insertVersion(input: {
    appId: string;
    key: string;
    version: number;
    sections: unknown;
    adminId: string;
    at: Date;
  }): Promise<void>;
  /**
   * The only write of page_versions.status: re-derives `change` from the generated transition (from + event), then
   * one UPDATE … SET status = change.to WHERE status = change.from (publish_at and publisher are
   * set with `stamp` when the change is to published). False when no row matched (a CAS miss).
   */
  setVersionStatus(
    appId: string,
    key: string,
    version: number,
    change: PageVersionTransition,
    stamp: { readonly publisher: string; readonly at: Date } | null,
  ): Promise<boolean>;
  /** Published versions other than `except`, newest publish_at first, ties by higher version. */
  successor(appId: string, key: string, except: number): Promise<number | undefined>;
  /**
   * One UPDATE of the three pointers, revision + 1, updated_by_admin_id and updated_at; `slot`
   * (F1-09p) sets the four scheduled_* columns, null clears them, undefined leaves them.
   */
  updatePage(
    appId: string,
    key: string,
    pointers: PagePointers,
    revision: number,
    adminId: string,
    at: Date,
    slot?: PageSlot | null,
  ): Promise<void>;
  audit(input: AuditInput): Promise<void>;
  /** F1-09p Y11: the page's due job (queue page-schedule) on this transaction, after `delaySeconds`. */
  enqueueScheduleDue(appId: string, key: string, delaySeconds: number): Promise<void>;
}

export interface PageConfigStore extends PageConfigReads {
  transaction<T>(work: (tx: PageConfigTx) => Promise<T>): Promise<T>;
}

/** Save / publish checks of a page's sections (home-schema shape + F1-09c), [] when valid. */
export type PageSectionsCheck = (sections: unknown, unionHostBlock: boolean) => readonly string[];

export class PageFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`page config: invalid ${fields.join(', ')}`);
    this.name = 'PageFieldsError';
    this.fields = fields;
  }
}

export class PageConflictError extends Error {
  constructor() {
    super('page config: revision conflict');
    this.name = 'PageConflictError';
  }
}

export class PageNotFoundError extends Error {
  constructor() {
    super('page config: no saved version');
    this.name = 'PageNotFoundError';
  }
}

/** F1-09p Y14: the page has no pending schedule to cancel (30701). */
export class PageScheduleNotFoundError extends Error {
  constructor() {
    super('page config: no pending schedule');
    this.name = 'PageScheduleNotFoundError';
  }
}

type WriteAction =
  | 'page_version_create'
  | 'page_publish'
  | 'page_publish_schedule'
  | 'page_schedule_cancel'
  | 'page_gray_update'
  | 'page_rollback';

interface WriteResult {
  readonly pointers: PagePointers;
  readonly version: number;
  readonly at: Date;
  readonly action: WriteAction;
  /** The slot after the write: undefined keeps it, null clears it. */
  readonly slot?: PageSlot | null;
}

/** What applying a due slot writes (the due job uses it too). */
export type PageScheduleTx = Pick<PageConfigTx, 'setVersionStatus' | 'updatePage'>;

/**
 * F1-09p Y8: on the locked `row`, a slot due at `now` takes effect as its immediate publish would
 * have then: the version draft → published through the generated transition, stamped with the
 * scheduler and the scheduled time; the pointers; revision + 1; updated by the scheduler at the
 * scheduled time; the slot cleared. No audit row (Y9). Returns the row as written (or `row` when
 * nothing was due). A version that is no longer a draft is a bug: it throws, so the caller's
 * transaction rolls back.
 */
export async function applyDueSchedule(
  tx: PageScheduleTx,
  appId: string,
  key: string,
  row: PageRow,
  now: Date,
): Promise<PageRow> {
  const page = effectivePage({ ...row, updatedBy: null, updatedAt: null }, now);
  const slot = page.applied;
  if (slot === null) return row;
  const change = pageVersionChange('draft', 'PUBLISH');
  if (
    !(await tx.setVersionStatus(appId, key, slot.version, change, {
      publisher: slot.by,
      at: slot.at,
    }))
  ) {
    throw new Error('content: the scheduled page version is no longer a draft');
  }
  const pointers: PagePointers = {
    currentVersion: page.currentVersion,
    grayVersion: page.grayVersion,
    grayPercent: page.grayPercent,
  };
  await tx.updatePage(appId, key, pointers, page.revision, slot.by, slot.at, null);
  return { ...pointers, revision: page.revision, slot: null };
}

function bounds(query: PageListQuery | undefined): { page: number; pageSize: number } {
  return { page: query?.page ?? 1, pageSize: query?.page_size ?? 20 };
}

function stateOf(key: string, row: PagePointers & { revision: number; slot: PageSlot | null }) {
  return {
    page_key: key,
    revision: row.revision,
    current_version: row.currentVersion,
    gray_version: row.grayVersion,
    gray_percent: row.grayPercent,
    // F1-09p 9.2 #8: the pending schedule (no scheduler id, no sections).
    scheduled:
      row.slot === null
        ? null
        : {
            version: row.slot.version,
            gray_percent: row.slot.grayPercent,
            publish_at: row.slot.at.toISOString(),
          },
  };
}

function pointersOf(row: PagePointers): PagePointers {
  return {
    currentVersion: row.currentVersion,
    grayVersion: row.grayVersion,
    grayPercent: row.grayPercent,
  };
}

export class PageConfigAdmin {
  readonly #store: PageConfigStore;
  readonly #clock: Clock;
  readonly #check: PageSectionsCheck;

  constructor(store: PageConfigStore, clock: Clock, check: PageSectionsCheck) {
    this.#store = store;
    this.#clock = clock;
    this.#check = check;
  }

  async list(appId: string, query?: PageListQuery): Promise<Schema<'AdminPageConfigList'>> {
    const { page, pageSize } = bounds(query);
    const { items, total } = await this.#store.pages(appId, (page - 1) * pageSize, pageSize);
    return { items, page, page_size: pageSize, total };
  }

  async page(appId: string, key: string): Promise<PageView> {
    const view = await this.#store.page(appId, key);
    if (view === undefined) throw new PageNotFoundError();
    return view;
  }

  async versions(
    appId: string,
    key: string,
    query?: PageListQuery,
  ): Promise<Schema<'AdminPageConfigVersionList'>> {
    const { page, pageSize } = bounds(query);
    // A page with no saved version is 30701, not an empty history.
    if ((await this.#store.page(appId, key)) === undefined) throw new PageNotFoundError();
    const { items, total } = await this.#store.versions(
      appId,
      key,
      (page - 1) * pageSize,
      pageSize,
    );
    return { items, page, page_size: pageSize, total };
  }

  async version(appId: string, key: string, version: number): Promise<PageVersionView> {
    const view = await this.#store.version(appId, key, version);
    if (view === undefined) throw new PageNotFoundError();
    return view;
  }

  /** adminCreatePageConfigVersion: a new draft numbered newest + 1; the first save makes the page. */
  async save(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigDraftRequest'>,
  ): Promise<PageVersionView> {
    return this.#store.transaction(async (tx) => {
      // Sections depend only on the request: checked before the page row is touched (F1).
      this.#validate(body.sections, await tx.unionHostBlock(actor.appId));
      const at = this.#clock.now();
      await tx.ensurePage(actor.appId, key, at);
      const locked = await tx.lock(actor.appId, key);
      if (locked === undefined) throw new Error('content: page row missing after ensurePage');
      const row = await applyDueSchedule(tx, actor.appId, key, locked, at);
      if (row.revision !== body.expected_revision) throw new PageConflictError();
      const version = ((await tx.latestVersion(actor.appId, key)) ?? 0) + 1;
      await tx.insertVersion({
        appId: actor.appId,
        key,
        version,
        sections: body.sections,
        adminId: actor.adminId,
        at,
      });
      await this.#finish(tx, actor, key, row, {
        pointers: pointersOf(row),
        version,
        at,
        action: 'page_version_create',
      });
      const view = await tx.version(actor.appId, key, version);
      if (view === undefined) throw new Error('content: saved page version not readable');
      return view;
    });
  }

  /**
   * adminPublishPageConfig: 100 = fully released (the previous one stays published), 1..99 gray.
   * With publish_at (F1-09p): the same checks, then publish_at in (now, now + 30 days], and only the
   * page's slot is written (the version stays draft) with its due job; a pending slot refuses any
   * publish ([publish_at], before the version checks).
   */
  async publish(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigPublishRequest'>,
  ): Promise<PageView> {
    return this.#write(actor, key, body.expected_revision, async (tx, row) => {
      if (row.slot !== null) throw new PageFieldsError(['publish_at']);
      const target = await tx.versionRow(actor.appId, key, body.version);
      if (target === undefined || !canChangePageVersion(target.status, 'PUBLISH')) {
        throw new PageFieldsError(['version']);
      }
      if (row.grayVersion !== null) throw new PageFieldsError(['version']);
      if (row.currentVersion === null && body.gray_percent !== 100) {
        throw new PageFieldsError(['gray_percent']);
      }
      this.#validate(target.sections, await tx.unionHostBlock(actor.appId));
      const at = this.#clock.now();
      if (body.publish_at !== undefined) {
        const due = instantOf(at, body.publish_at);
        if (!isSchedulable(due, at)) throw new PageFieldsError(['publish_at']);
        return {
          pointers: pointersOf(row),
          version: body.version,
          at,
          action: 'page_publish_schedule',
          slot: {
            version: body.version,
            grayPercent: body.gray_percent,
            at: due,
            by: actor.adminId,
          },
        };
      }
      const change = pageVersionChange(target.status, 'PUBLISH');
      const stamp = { publisher: actor.adminId, at };
      if (!(await tx.setVersionStatus(actor.appId, key, body.version, change, stamp))) {
        throw new PageConflictError();
      }
      const pointers: PagePointers =
        body.gray_percent === 100
          ? { currentVersion: body.version, grayVersion: null, grayPercent: 0 }
          : {
              currentVersion: row.currentVersion,
              grayVersion: body.version,
              grayPercent: body.gray_percent,
            };
      return { pointers, version: body.version, at, action: 'page_publish' };
    });
  }

  /** adminUpdatePageConfigGray: 1..99 changes the share, 100 releases the gray version fully. */
  async gray(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigGrayRequest'>,
  ): Promise<PageView> {
    return this.#write(actor, key, body.expected_revision, async (_tx, row) => {
      const gray = row.grayVersion;
      if (gray === null) throw new PageFieldsError(['gray_percent']);
      // Releasing fully keeps the version's publish_at / publisher (F2).
      const pointers: PagePointers =
        body.gray_percent === 100
          ? { currentVersion: gray, grayVersion: null, grayPercent: 0 }
          : {
              currentVersion: row.currentVersion,
              grayVersion: gray,
              grayPercent: body.gray_percent,
            };
      return { pointers, version: gray, at: this.#clock.now(), action: 'page_gray_update' };
    });
  }

  /**
   * adminRollbackPageConfig: the gray version, or (without one) the fully released version, which
   * falls back to the other published version with the latest publish_at, ties by higher number.
   */
  async rollback(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigRollbackRequest'>,
  ): Promise<PageView> {
    return this.#write(actor, key, body.expected_revision, async (tx, row) => {
      let pointers: PagePointers;
      if (row.grayVersion !== null && body.version === row.grayVersion) {
        pointers = { currentVersion: row.currentVersion, grayVersion: null, grayPercent: 0 };
      } else if (
        row.currentVersion !== null &&
        body.version === row.currentVersion &&
        row.grayVersion === null
      ) {
        const next = await tx.successor(actor.appId, key, body.version);
        if (next === undefined) throw new PageFieldsError(['version']);
        pointers = { currentVersion: next, grayVersion: null, grayPercent: 0 };
      } else {
        throw new PageFieldsError(['version']);
      }
      // The gray and the fully released pointers only ever name published versions; the CAS
      // turns a version changed meanwhile into a conflict instead of a blind write.
      const change = pageVersionChange('published', 'ROLLBACK');
      if (!(await tx.setVersionStatus(actor.appId, key, body.version, change, null))) {
        throw new PageConflictError();
      }
      return { pointers, version: body.version, at: this.#clock.now(), action: 'page_rollback' };
    });
  }

  /**
   * adminCancelPageConfigSchedule (F1-09p): clears the pending slot; a due slot has already taken
   * effect (applied before the CAS), so there is none to cancel (30701). Queued jobs stay: they
   * find no slot and do nothing.
   */
  async cancelSchedule(actor: PageActor, key: string, expectedRevision: number): Promise<PageView> {
    return this.#write(actor, key, expectedRevision, async (_tx, row) => {
      if (row.slot === null) throw new PageScheduleNotFoundError();
      return {
        pointers: pointersOf(row),
        version: row.slot.version,
        at: this.#clock.now(),
        action: 'page_schedule_cancel',
        slot: null,
      };
    });
  }

  /**
   * Publish / gray / rollback / cancel: lock, 30701, apply a due slot, CAS, then the operation's
   * own checks and pointers; a new slot enqueues its due job in the same transaction.
   */
  async #write(
    actor: PageActor,
    key: string,
    expectedRevision: number,
    change: (tx: PageConfigTx, row: PageRow) => Promise<WriteResult>,
  ): Promise<PageView> {
    return this.#store.transaction(async (tx) => {
      const locked = await tx.lock(actor.appId, key);
      if (locked === undefined || (await tx.latestVersion(actor.appId, key)) === null) {
        throw new PageNotFoundError();
      }
      const row = await applyDueSchedule(tx, actor.appId, key, locked, this.#clock.now());
      if (row.revision !== expectedRevision) throw new PageConflictError();
      const result = await change(tx, row);
      await this.#finish(tx, actor, key, row, result);
      if (result.slot !== undefined && result.slot !== null) {
        await tx.enqueueScheduleDue(
          actor.appId,
          key,
          slotDelaySeconds(result.slot.at, this.#clock.now()),
        );
      }
      const view = await tx.page(actor.appId, key);
      if (view === undefined) throw new Error('content: written page not readable');
      return view;
    });
  }

  async #finish(
    tx: PageConfigTx,
    actor: PageActor,
    key: string,
    before: PageRow,
    result: WriteResult,
  ): Promise<void> {
    const { pointers, version, at, action } = result;
    const revision = before.revision + 1;
    const slot = result.slot === undefined ? before.slot : result.slot;
    await tx.updatePage(actor.appId, key, pointers, revision, actor.adminId, at, result.slot);
    // Sections stay out of the audit row (the version table keeps them).
    await tx.audit({
      appId: actor.appId,
      actor: actor.adminId,
      action,
      target: key,
      before: { ...stateOf(key, before), version },
      after: { ...stateOf(key, { ...pointers, revision, slot }), version },
      ip: actor.ip,
    });
  }

  #validate(sections: unknown, switchValue: unknown): void {
    // Missing or any value other than boolean false keeps the block on (F1-02c 裁定 8 口径).
    const fields = this.#check(sections, switchValue !== false);
    if (fields.length > 0) throw new PageFieldsError(fields);
  }
}
