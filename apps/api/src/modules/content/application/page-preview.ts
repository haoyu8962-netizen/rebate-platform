// Page preview (F1-09e): the console issues a preview token for one saved version of a page
// (adminCreatePagePreviewToken, permission content.page, no step-up), and the test build's
// HomePreview route reads that version with it (previewPage, x-auth none). 04 §3.2
// page_preview_tokens, §6.2 preview, §11.2 content.page; F1-09e brief §9.2.
//
// Issue: a page without a pages row or without any saved version → 30701; a version the page
// does not have → 20001 data.fields=[version]; any status (draft / published / rolled_back) can
// be signed. The token is 32 random bytes (base64url, 43 characters); only the lowercase sha256
// hex of its UTF-8 bytes is stored. created_at and expire_at both come from one reading of the
// injected Clock (the table's CHECK keeps expire_at within 10 minutes of created_at). The audit
// row is appended on the same transaction and carries neither the token nor its hash.
//
// Read: one atomic UPDATE (used_count + 1) matches the token hash, the page key, the app and an
// expire_at later than the injected Clock; no row → the same 30701 for every cause (unknown,
// expired, another page, another app or another environment), and a refusal changes nothing.
// The pinned version's sections are returned as stored: no gray, threshold or audience filter,
// no cache.
import { createHash, randomBytes } from 'node:crypto';
import type { AuditInput, Clock } from '../../platform/index.ts';

/** Lifetime of a preview token (04 §3.2: 10 minutes). */
export const PREVIEW_TOKEN_TTL_MS = 600_000;
/** Random bytes per token (台账: at least 32). */
export const PREVIEW_TOKEN_BYTES = 32;
/** Audit action of an issue (no name in 规划 or the contract; 编排者默认 E2). */
export const PREVIEW_TOKEN_AUDIT_ACTION = 'page_preview_token_issue';

/** The guard's verified admin; the request contributes only its address for the audit row. */
export interface PagePreviewActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface PagePreviewTokenRow {
  readonly tokenHash: string;
  readonly appId: string;
  readonly pageKey: string;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expireAt: Date;
}

/** Statements of one issue transaction. */
export interface PagePreviewIssueTx {
  /** Whether the app has a pages row for the key and at least one saved version of it. */
  pageHasVersions(appId: string, pageKey: string): Promise<boolean>;
  versionExists(appId: string, pageKey: string, version: number): Promise<boolean>;
  insertToken(row: PagePreviewTokenRow): Promise<void>;
  audit(input: AuditInput): Promise<void>;
}

export interface PagePreviewConsumeInput {
  readonly appId: string;
  readonly pageKey: string;
  readonly tokenHash: string;
  readonly now: Date;
}

export interface PagePreviewStore {
  transaction<T>(work: (tx: PagePreviewIssueTx) => Promise<T>): Promise<T>;
  /**
   * One statement: count a hit of a live token for this app and page and return its version;
   * undefined when no token matches (nothing changes then).
   */
  consume(input: PagePreviewConsumeInput): Promise<number | undefined>;
  /** Stored sections of one version; undefined when the version row is absent. */
  sections(appId: string, pageKey: string, version: number): Promise<unknown[] | undefined>;
}

export interface IssuedPreviewToken {
  readonly token: string;
  readonly page_key: string;
  readonly version: number;
  readonly expire_at: string;
}

export interface PagePreview {
  readonly page_key: string;
  readonly version: number;
  readonly sections: Record<string, unknown>[];
}

/** 30701: no such page (issue), or the token does not open this page here (read). */
export class PagePreviewNotFoundError extends Error {
  constructor() {
    super('content: page preview not found');
    this.name = 'PagePreviewNotFoundError';
  }
}

/** 20001 with data.fields. */
export class PagePreviewFieldsError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`content: page preview fields invalid: ${fields.join(',')}`);
    this.name = 'PagePreviewFieldsError';
    this.fields = fields;
  }
}

/** Lowercase sha256 hex of the token's UTF-8 bytes (the only form stored). */
export function previewTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface PagePreviewServiceOptions {
  readonly store: PagePreviewStore;
  readonly clock: Clock;
  /** Token source; defaults to node:crypto randomBytes (tests may pin it). */
  readonly random?: (size: number) => Buffer;
}

export class PagePreviewService {
  readonly #store: PagePreviewStore;
  readonly #clock: Clock;
  readonly #random: (size: number) => Buffer;

  constructor(options: PagePreviewServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#random = options.random ?? randomBytes;
  }

  /** adminCreatePagePreviewToken. */
  async issue(
    actor: PagePreviewActor,
    pageKey: string,
    version: number,
  ): Promise<IssuedPreviewToken> {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new PagePreviewFieldsError(['version']);
    }
    const bytes = this.#random(PREVIEW_TOKEN_BYTES);
    if (bytes.length < PREVIEW_TOKEN_BYTES) throw new Error('content: preview token too short');
    const token = bytes.toString('base64url');
    const tokenHash = previewTokenHash(token);
    // One reading for both columns: the table CHECK compares them.
    const createdAt = this.#clock.now();
    const expireAt = structuredClone(createdAt);
    expireAt.setTime(createdAt.getTime() + PREVIEW_TOKEN_TTL_MS);
    const expire = expireAt.toISOString();
    await this.#store.transaction(async (tx) => {
      if (!(await tx.pageHasVersions(actor.appId, pageKey))) throw new PagePreviewNotFoundError();
      if (!(await tx.versionExists(actor.appId, pageKey, version))) {
        throw new PagePreviewFieldsError(['version']);
      }
      await tx.insertToken({
        tokenHash,
        appId: actor.appId,
        pageKey,
        version,
        createdBy: actor.adminId,
        createdAt,
        expireAt,
      });
      // Neither the token nor its hash: the audit log has more readers than the token.
      await tx.audit({
        appId: actor.appId,
        actor: actor.adminId,
        action: PREVIEW_TOKEN_AUDIT_ACTION,
        target: `pages:${pageKey}`,
        before: null,
        after: { page_key: pageKey, version, expire_at: expire },
        ip: actor.ip,
      });
    });
    return { token, page_key: pageKey, version, expire_at: expire };
  }

  /** previewPage: every refusal is the same PagePreviewNotFoundError. */
  async read(appId: string, pageKey: string, token: string): Promise<PagePreview> {
    const version = await this.#store.consume({
      appId,
      pageKey,
      tokenHash: previewTokenHash(token),
      now: this.#clock.now(),
    });
    if (version === undefined) throw new PagePreviewNotFoundError();
    const sections = await this.#store.sections(appId, pageKey, version);
    // The token's foreign key pins an existing version; a missing row is a broken invariant.
    if (sections === undefined) throw new Error('content: preview token without its version');
    return { page_key: pageKey, version, sections: sections as Record<string, unknown>[] };
  }
}
