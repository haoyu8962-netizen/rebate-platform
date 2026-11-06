// B1-03zg: the console's risk rule list and enable / disable (CT-24f adminListRiskRules,
// adminEnableRiskRule, adminDisableRiskRule; BR-ID-36 细则「规则清单的启停」; admin entry only).
//
// list(appId): every risk_rules row of the app, by scene, then rule_id; the eight AdminRiskRule
// fields only (never the conditions JSON); name and threshold_keys from ./risk-rule-catalog.ts
// (a code the catalog lacks: name = rule_id, threshold_keys = [], one warn line).
// change(command): one transaction. First the rule row of (app_id, rule_id) under FOR UPDATE (no
// such row in the console's app → 20001 [rule_id]); then expected_version against its version
// (mismatch → 20902, resource risk_rule); a rule already in the target status with a matching
// version is returned unchanged, without an audit record; otherwise the compare-and-set itself is
// the UPDATE (WHERE id, app_id, rule_id and version = expected_version): the target status,
// version + 1, updated_at from the injected Clock, and one audit record (risk_rule_enable /
// risk_rule_disable, before and after status, reason) in the same transaction. The row lock makes
// two concurrent calls with the same expected_version take effect at most once.
//
// The rule writers (blocklist.ts, order-blocklist.ts, same-device-accounts.ts,
// invite-relation-hits.ts, identity's risk ports) register their rows with status 'active', a
// value outside the contract's risk_rule_status: it is read as enabled, here and in the list.
// TODO(规划/11 §2.3): 规则写入方改为登记 status enabled — blocked on 写入方不在本任务路径内
import type { DB as Database } from '@couli/db';
import type { Schema } from '@couli/contracts-ts';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock, RootLogger } from '../../platform/index.ts';
import { riskRuleCatalogEntry } from './risk-rule-catalog.ts';

/** One row of the list, as the contract's AdminRiskRule. */
export type AdminRiskRuleView = Schema<'AdminRiskRule'>;

/** The two writes. */
export type AdminRiskRuleChange = 'enable' | 'disable';

export interface AdminRiskRulesOptions {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  /** Warns about a rule_id the catalog lacks. */
  readonly logger: RootLogger;
  /** Binds the audit port to the change's transaction (app.module: admin's audit writer). */
  readonly auditOn: (trx: Transaction<Database>) => AuditPort;
}

export interface AdminRiskRuleCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly ruleId: string;
  readonly change: AdminRiskRuleChange;
  readonly body: Schema<'AdminRiskRuleStatusChangeRequest'>;
}

/** 20001 with data.fields. */
export class AdminRiskRulesFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`risk: invalid ${fields.join(', ')}`);
    this.name = 'AdminRiskRulesFieldsError';
    this.fields = fields;
  }
}

/** 20902 with data.resource = risk_rule. */
export class AdminRiskRuleConflictError extends Error {
  constructor() {
    super('risk: the risk rule version has changed');
    this.name = 'AdminRiskRuleConflictError';
  }
}

type Status = AdminRiskRuleView['status'];
type RuleRow = Pick<
  Selectable<Database['risk_rules']>,
  'id' | 'rule_id' | 'scene' | 'risk_action' | 'status' | 'version' | 'updated_at'
>;

const COLUMNS = [
  'id',
  'rule_id',
  'scene',
  'risk_action',
  'status',
  'version',
  'updated_at',
] as const;

const REASON_MAX = 200;
const INT4_MAX = 2_147_483_647;
const TARGET: Readonly<Record<AdminRiskRuleChange, Status>> = {
  enable: 'enabled',
  disable: 'disabled',
};

/** The stored status as the contract's risk_rule_status ('active' of the writers = enabled). */
export function riskRuleStatusOf(stored: string): Status {
  return stored === 'disabled' ? 'disabled' : 'enabled';
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

interface Checked {
  readonly expected: number;
  readonly reason: string | null;
}

/** The body rules (the route schema checks them first; re-checked for a direct call). */
function check(body: unknown): Checked {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const fields: string[] = [];
  const expected = input['expected_version'];
  const expectedOk =
    typeof expected === 'number' &&
    Number.isInteger(expected) &&
    expected >= 0 &&
    expected <= INT4_MAX;
  if (!expectedOk) fields.push('expected_version');
  const has = Object.prototype.hasOwnProperty.call(input, 'reason');
  const reason = input['reason'];
  const reasonOk =
    !has ||
    reason === undefined ||
    (typeof reason === 'string' && codePoints(reason) >= 1 && codePoints(reason) <= REASON_MAX);
  if (!reasonOk) fields.push('reason');
  if (fields.length > 0) throw new AdminRiskRulesFieldsError(fields);
  return {
    expected: expected as number,
    reason: typeof reason === 'string' ? reason : null,
  };
}

export class AdminRiskRules {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;
  readonly #logger: RootLogger;
  readonly #auditOn: AdminRiskRulesOptions['auditOn'];

  constructor(options: AdminRiskRulesOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#auditOn = options.auditOn;
  }

  /** Every rule of the app, by scene, then rule_id. */
  async list(appId: string): Promise<AdminRiskRuleView[]> {
    const rows = await this.#db
      .withSchema('app')
      .selectFrom('risk_rules')
      .select(COLUMNS)
      .where('app_id', '=', appId)
      .orderBy('scene')
      .orderBy('rule_id')
      .execute();
    return rows.map((row) => this.#view(appId, row));
  }

  /** Enables or disables one rule (compare-and-set on version); the rule as listed now. */
  async change(command: AdminRiskRuleCommand): Promise<AdminRiskRuleView> {
    const checked = check(command.body);
    const { appId, ruleId } = command;
    const target = TARGET[command.change];
    return this.#db.transaction().execute(async (trx) => {
      const current = await trx
        .withSchema('app')
        .selectFrom('risk_rules')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('rule_id', '=', ruleId)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new AdminRiskRulesFieldsError(['rule_id']);
      if (current.version !== checked.expected) throw new AdminRiskRuleConflictError();
      const from = riskRuleStatusOf(current.status);
      if (from === target) return this.#view(appId, current);
      const updated = await trx
        .withSchema('app')
        .updateTable('risk_rules')
        .set((eb) => ({
          status: target,
          version: eb('version', '+', 1),
          row_version: eb('row_version', '+', 1),
          updated_at: this.#clock.now(),
        }))
        .where('id', '=', current.id)
        .where('app_id', '=', appId)
        .where('rule_id', '=', ruleId)
        .where('version', '=', checked.expected)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (updated === undefined) throw new AdminRiskRuleConflictError();
      await this.#auditOn(trx).append({
        appId,
        actor: command.adminId,
        action: `risk_rule_${command.change}`,
        target: ruleId,
        before: { rule_id: ruleId, status: from, version: current.version },
        after: {
          rule_id: ruleId,
          status: target,
          version: updated.version,
          reason: checked.reason,
        },
        ip: command.ip,
      });
      return this.#view(appId, updated);
    });
  }

  #view(appId: string, row: RuleRow): AdminRiskRuleView {
    const entry = riskRuleCatalogEntry(row.rule_id);
    if (entry === null) {
      this.#logger.warn(
        { app_id: appId, rule_id: row.rule_id },
        'risk: rule_id missing from the risk rule catalog, listed with its code as name',
      );
    }
    return {
      rule_id: row.rule_id,
      scene: row.scene,
      name: entry === null ? row.rule_id : entry.name,
      risk_action: row.risk_action as AdminRiskRuleView['risk_action'],
      status: riskRuleStatusOf(row.status),
      threshold_keys: entry === null ? [] : [...entry.thresholdKeys],
      version: row.version,
      updated_at: row.updated_at.toISOString(),
    };
  }
}
