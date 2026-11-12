import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Logger } from 'pino';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  configItemSpecOf,
  configRegistry,
  configValueFits,
  type ConfigItemSpec,
  type ConfigPermission,
} from '../domain/config-registry.ts';
import {
  INVITE_REWARD_ENABLED,
  inviteRewardEnabled,
  inviteRewardGuardedKey,
  inviteRewardPositive,
  inviteRewardZeroedKeys,
} from '../domain/invite-reward.ts';

type Json = DB['config_items']['value'];
/**
 * B1-22zb: the key whose saves take the per-app lock. Kept here, not imported from
 * ai-consent-version-save-check.ts, which imports this module (no-circular).
 */
const AI_CONSENT_VERSION_KEY = 'legal.ai_third_party.version';
type Item = Schema<'AdminConfigItem'>;
type Entry = Schema<'AdminConfigItemBatchEntry'>;
export type ConfigPageQuery = { readonly page?: number; readonly page_size?: number };

export interface ConfigItemRow {
  readonly key: string;
  readonly value: Json;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export interface ConfigItemActor {
  readonly appId: string;
  readonly adminId: string;
  readonly loginName: string;
  readonly ip: string | null;
  readonly traceId: string;
}

export interface ConfigItemWrite {
  readonly actor: ConfigItemActor;
  readonly key: string;
  readonly value: Json;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly at: Date;
}

export interface ConfigItemTx {
  lock(appId: string, key: string): Promise<ConfigItemRow | undefined>;
  version(appId: string, key: string, version: number): Promise<{ value: Json } | undefined>;
  change(input: ConfigItemWrite): Promise<ConfigItemRow | undefined>;
  history(input: ConfigItemWrite, version: number): Promise<void>;
  /** F1-02zn: the invite reward campaign's transaction lock (shared with kill-switch writes). */
  lockInviteReward(appId: string): Promise<void>;
  /**
   * B1-22zb: the transaction lock of one app's legal.ai_third_party.version saves, taken first in
   * the transaction (before its current value is read), so two saves of that key queue even when
   * no row exists yet to lock, and the later one compares against the earlier one's commit.
   * Optional only for fakes that never write that key: a write of it fails without the lock.
   */
  lockAiConsentVersion?(appId: string): Promise<void>;
  /** Current values of the named keys (full keys); a missing row is absent. */
  values(appId: string, keys: readonly string[]): Promise<ReadonlyMap<string, Json>>;
  audit(input: AuditInput): Promise<void>;
}

export interface ConfigItemStore {
  rows(appId: string): Promise<readonly ConfigItemRow[]>;
  row(appId: string, key: string): Promise<ConfigItemRow | undefined>;
  versions(
    appId: string,
    key: string,
    page: number,
    pageSize: number,
  ): Promise<Schema<'AdminConfigItemVersionPage'>>;
  transaction<T>(work: (tx: ConfigItemTx) => Promise<T>): Promise<T>;
}

export class ConfigItemFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`config item: invalid ${fields.join(', ')}`);
    this.name = 'ConfigItemFieldsError';
    this.fields = fields;
  }
}

export class ConfigItemConflictError extends Error {
  constructor() {
    super('config item: version conflict');
    this.name = 'ConfigItemConflictError';
  }
}

export function requireConfigItem(key: string, writable = false): ConfigItemSpec {
  const spec = configItemSpecOf(key);
  if (spec === null || (writable && !spec.adminEditable)) {
    throw new ConfigItemFieldsError(['key']);
  }
  return spec;
}

/** Validate the complete batch before any version read, and select its one guard point. */
export function configBatchPermission(items: readonly Entry[]): ConfigPermission {
  const points = new Set<ConfigPermission>();
  const keys = new Set<string>();
  const failed: string[] = [];
  for (const item of items) {
    if (keys.has(item.key)) throw new ConfigItemFieldsError(['items']);
    keys.add(item.key);
    const spec = configItemSpecOf(item.key);
    if (spec !== null) points.add(spec.permission);
    if (spec === null || !spec.adminEditable || !configValueFits(spec, item.value)) {
      failed.push(item.key);
    }
  }
  if (points.size > 1 || items.length === 0) throw new ConfigItemFieldsError(['items']);
  if (failed.length > 0) throw new ConfigItemFieldsError(failed);
  const point = points.values().next().value;
  if (point === undefined) throw new ConfigItemFieldsError(['items']);
  return point;
}

function itemOf(key: string, row: ConfigItemRow | undefined): Item {
  const spec = requireConfigItem(key);
  return {
    key,
    value: row?.value ?? null,
    value_type: spec.valueType,
    options: spec.options === null ? null : [...spec.options],
    permission: spec.permission,
    admin_editable: spec.adminEditable,
    version: row?.version ?? 0,
    updated_by: row?.updatedBy ?? null,
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}

/** JSON equality ignores object key order, preserves array order, and treats -0 as 0. */
function sameValue(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]!))
    );
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key]!, right[key]!))
  );
}

/**
 * B2-11d: checks the assembler (app.module) injects. save is payout's BR-WDR-30 保存时校验: `keys`
 * the configuration it reads, `refusals(stored, written)` the written keys it refuses given the
 * caller's stored rows of `keys` (absent = unset) and the values the write sets. Absent, every
 * write is checked on its own item only, as before.
 */
export interface ConfigItemAdminChecks {
  readonly save?: ConfigItemSaveCheck;
}

export interface ConfigItemSaveCheck {
  readonly keys: readonly string[];
  refusals(
    stored: ReadonlyMap<string, unknown>,
    written: ReadonlyMap<string, unknown>,
  ): readonly string[];
}

/**
 * B1-05m: one save check made of several (payout's BR-WDR-30 and catalog's search keys): it reads
 * every check's keys, and a check runs only when the write sets one of its own keys, so each keeps
 * the behaviour it has alone; the refused keys are joined in check order without repeats.
 */
export function combineConfigItemSaveChecks(
  ...checks: readonly ConfigItemSaveCheck[]
): ConfigItemSaveCheck {
  return {
    keys: [...new Set(checks.flatMap((check) => check.keys))],
    refusals(stored, written) {
      const refused: string[] = [];
      for (const check of checks) {
        if (!check.keys.some((key) => written.has(key))) continue;
        const own = new Map([...stored].filter(([key]) => check.keys.includes(key)));
        for (const key of check.refusals(own, written)) {
          if (!refused.includes(key)) refused.push(key);
        }
      }
      return refused;
    },
  };
}

interface ChangeResult {
  readonly row: ConfigItemRow;
  readonly before: Json;
  readonly changed: boolean;
}

export class ConfigItemAdmin {
  readonly #store: ConfigItemStore;
  readonly #clock: Clock;
  readonly #logger: Pick<Logger, 'warn'>;
  readonly #checks: ConfigItemAdminChecks;

  constructor(
    store: ConfigItemStore,
    clock: Clock,
    logger: Pick<Logger, 'warn'>,
    checks: ConfigItemAdminChecks = {},
  ) {
    this.#store = store;
    this.#clock = clock;
    this.#logger = logger;
    this.#checks = checks;
  }

  /** B2-11d: the same use case over the same store, with `checks` (the assembler's injection). */
  withChecks(checks: ConfigItemAdminChecks): ConfigItemAdmin {
    return new ConfigItemAdmin(this.#store, this.#clock, this.#logger, checks);
  }

  async list(appId: string, query: ConfigPageQuery): Promise<Schema<'AdminConfigItemPage'>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const rows = new Map((await this.#store.rows(appId)).map((row) => [row.key, row]));
    const specs = configRegistry();
    return {
      items: specs
        .slice((page - 1) * pageSize, page * pageSize)
        .map((spec) => itemOf(spec.key, rows.get(spec.key))),
      page,
      page_size: pageSize,
      total: specs.length,
    };
  }

  async get(appId: string, key: string): Promise<Item> {
    requireConfigItem(key);
    return itemOf(key, await this.#store.row(appId, key));
  }

  async versions(
    appId: string,
    key: string,
    query: ConfigPageQuery,
  ): Promise<Schema<'AdminConfigItemVersionPage'>> {
    requireConfigItem(key);
    return this.#store.versions(appId, key, query.page ?? 1, query.page_size ?? 20);
  }

  async update(
    actor: ConfigItemActor,
    key: string,
    body: Schema<'AdminConfigItemUpdateRequest'>,
  ): Promise<Item> {
    const spec = requireConfigItem(key, true);
    if (!configValueFits(spec, body.value)) throw new ConfigItemFieldsError(['value']);
    const zeroed = inviteRewardZeroedKeys([{ key, value: body.value }]);
    const result = await this.#store.transaction(async (tx) => {
      await this.#lockAiConsentVersion(tx, actor.appId, [key]);
      // Campaign lock first, then the row lock: the same order as the switch write.
      if (zeroed.length > 0) await tx.lockInviteReward(actor.appId);
      if (this.#saveChecked([key])) {
        await this.#lockSaveKeys(tx, actor.appId);
        await this.#refuseSave(tx, actor.appId, new Map([[key, body.value]]), () => ['value']);
      }
      const before = await tx.lock(actor.appId, key);
      if (zeroed.length > 0) await this.#refuseWhileEnabled(tx, actor.appId, ['value']);
      return this.#change(tx, actor, { key, ...body }, before, body.reason ?? null);
    });
    this.#alert(actor, result);
    return itemOf(key, result.row);
  }

  async batch(
    actor: ConfigItemActor,
    body: Schema<'AdminConfigItemBatchRequest'>,
  ): Promise<Schema<'AdminConfigItemList'>> {
    configBatchPermission(body.items);
    const zeroed = inviteRewardZeroedKeys(body.items);
    const results = await this.#store.transaction(async (tx) => {
      await this.#lockAiConsentVersion(
        tx,
        actor.appId,
        body.items.map((item) => item.key),
      );
      // The whole batch is refused, before any write, when it zeroes a guarded key while the
      // invite reward campaign is on; fields name every such key.
      if (zeroed.length > 0) {
        await tx.lockInviteReward(actor.appId);
        await this.#refuseWhileEnabled(tx, actor.appId, zeroed);
      }
      // B2-11d: the whole batch is refused, before any write, when the configuration it would
      // leave breaks the BR-WDR-30 save check; fields name the refused written keys.
      if (this.#saveChecked(body.items.map((item) => item.key))) {
        await this.#lockSaveKeys(tx, actor.appId);
        const written = new Map(body.items.map((item) => [item.key, item.value]));
        await this.#refuseSave(tx, actor.appId, written, (refused) => refused);
      }
      // Finish each key in sorted order, including INSERTs: absent rows cannot be locked
      // by SELECT FOR UPDATE. Any later conflict rolls back every earlier key's writes.
      const sorted = [...body.items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const changed = new Map<string, ChangeResult>();
      for (const item of sorted) {
        const before = await tx.lock(actor.appId, item.key);
        changed.set(item.key, await this.#change(tx, actor, item, before, body.reason ?? null));
      }
      return body.items.map((item) => changed.get(item.key)!);
    });
    for (const result of results) this.#alert(actor, result);
    return { items: results.map((result) => itemOf(result.row.key, result.row)) };
  }

  async rollback(
    actor: ConfigItemActor,
    key: string,
    body: Schema<'AdminConfigItemRollbackRequest'>,
  ): Promise<Item> {
    const spec = requireConfigItem(key, true);
    // The restored value is only known inside the transaction: lock for every guarded key.
    const guarded = inviteRewardGuardedKey(key);
    const result = await this.#store.transaction(async (tx) => {
      await this.#lockAiConsentVersion(tx, actor.appId, [key]);
      if (guarded) await tx.lockInviteReward(actor.appId);
      const saveChecked = this.#saveChecked([key]);
      if (saveChecked) await this.#lockSaveKeys(tx, actor.appId);
      const before = await tx.lock(actor.appId, key);
      const historical = await tx.version(actor.appId, key, body.to_version);
      // Check the historical value and target before the expected_version comparison.
      if (
        before === undefined ||
        body.to_version >= before.version ||
        historical === undefined ||
        !configValueFits(spec, historical.value)
      ) {
        throw new ConfigItemFieldsError(['to_version']);
      }
      if (saveChecked) {
        const written = new Map([[key, historical.value]]);
        await this.#refuseSave(tx, actor.appId, written, () => ['to_version']);
      }
      if (guarded && !inviteRewardPositive(historical.value)) {
        await this.#refuseWhileEnabled(tx, actor.appId, ['to_version']);
      }
      return this.#change(
        tx,
        actor,
        { key, value: historical.value, expected_version: body.expected_version },
        before,
        body.reason ?? null,
        body.to_version,
      );
    });
    this.#alert(actor, result);
    return itemOf(key, result.row);
  }

  /**
   * B1-22zb: the per-app lock of legal.ai_third_party.version saves, only when the write touches
   * that key (other keys' saves take no extra lock). First in the transaction: before any row lock
   * and before the current value is read. The kill-switch write never takes it, so its order
   * relative to the invite reward campaign lock cannot invert.
   */
  async #lockAiConsentVersion(
    tx: ConfigItemTx,
    appId: string,
    keys: readonly string[],
  ): Promise<void> {
    if (!keys.includes(AI_CONSENT_VERSION_KEY)) return;
    if (tx.lockAiConsentVersion === undefined) {
      throw new Error('config item: the store cannot lock legal.ai_third_party.version saves');
    }
    await tx.lockAiConsentVersion(appId);
  }

  /** B2-11d: whether a write of `keys` touches the configuration the save check reads. */
  #saveChecked(keys: readonly string[]): boolean {
    const save = this.#checks.save;
    return save !== undefined && keys.some((key) => save.keys.includes(key));
  }

  /**
   * B2-11d: locks the existing rows the save check reads, in key order and before any written
   * row, so two writes of keys the check compares (e.g. platform_daily_max_fen and
   * payout.daily_cap_fen) see each other's committed value instead of both passing.
   */
  async #lockSaveKeys(tx: ConfigItemTx, appId: string): Promise<void> {
    const keys = [...(this.#checks.save?.keys ?? [])].sort();
    for (const key of keys) await tx.lock(appId, key);
  }

  /**
   * B2-11d: 20001 `fields(refused)` when the configuration `written` would leave breaks the save
   * check (call under #lockSaveKeys, only when #saveChecked).
   */
  async #refuseSave(
    tx: ConfigItemTx,
    appId: string,
    written: ReadonlyMap<string, unknown>,
    fields: (refused: readonly string[]) => readonly string[],
  ): Promise<void> {
    const save = this.#checks.save;
    if (save === undefined) return;
    const refused = save.refusals(await tx.values(appId, save.keys), written);
    if (refused.length > 0) throw new ConfigItemFieldsError(fields(refused));
  }

  /** F1-02zn: 20001 `fields` when the invite reward switch is currently on (call under lock). */
  async #refuseWhileEnabled(
    tx: ConfigItemTx,
    appId: string,
    fields: readonly string[],
  ): Promise<void> {
    const current = await tx.values(appId, [INVITE_REWARD_ENABLED]);
    if (inviteRewardEnabled(current.get(INVITE_REWARD_ENABLED))) {
      throw new ConfigItemFieldsError(fields);
    }
  }

  async #change(
    tx: ConfigItemTx,
    actor: ConfigItemActor,
    item: Entry,
    before: ConfigItemRow | undefined,
    reason: string | null,
    restoredVersion?: number,
  ): Promise<ChangeResult> {
    const fromVersion = before?.version ?? 0;
    if (fromVersion !== item.expected_version) throw new ConfigItemConflictError();
    // The generated request schema accepts JSON; registry validation has checked its type.
    const value = item.value as Json;
    // Rollback explicitly records a new version, even if the historical value is current.
    if (restoredVersion === undefined && before !== undefined && sameValue(before.value, value)) {
      return { row: before, before: before.value, changed: false };
    }
    const input: ConfigItemWrite = {
      actor,
      key: item.key,
      value,
      expectedVersion: item.expected_version,
      reason,
      at: this.#clock.now(),
    };
    const row = await tx.change(input);
    if (row === undefined) throw new ConfigItemConflictError();
    await tx.history(input, row.version);
    await tx.audit({
      appId: actor.appId,
      actor: actor.adminId,
      action: restoredVersion === undefined ? 'config_item_change' : 'config_item_rollback',
      target: item.key,
      before: { key: item.key, from_version: fromVersion, value: before?.value ?? null },
      after: {
        key: item.key,
        to_version: row.version,
        value,
        reason,
        ...(restoredVersion === undefined ? {} : { restored_version: restoredVersion }),
      },
      ip: actor.ip,
    });
    return { row, before: before?.value ?? null, changed: true };
  }

  #alert(actor: ConfigItemActor, result: ChangeResult): void {
    // Call only after commit: failures in any key's history/audit leave no alert behind.
    if (!result.changed) return;
    this.#logger.warn(
      {
        key: result.row.key,
        from_value: result.before,
        to_value: result.row.value,
        app_id: actor.appId,
        admin_id: actor.adminId,
        trace_id: actor.traceId,
      },
      'config_change_alert',
    );
  }
}
