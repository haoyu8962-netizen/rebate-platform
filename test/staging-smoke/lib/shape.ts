// STAGING-SMOKE (QA-04b): minimal hand-written shape checks against contracts/openapi.yaml (no
// schema library: the smoke adds no dependency). Only required fields, types, enums and the
// integer-ness of amounts are checked; a mismatch names the field path, never its value.
import { Fail } from './report.ts';

type Obj = Record<string, unknown>;

interface FieldOptions {
  readonly nullable?: boolean;
  /** The field may be absent (contract: not in `required`). */
  readonly optional?: boolean;
}

export class Shape {
  readonly #where: string;
  readonly #errors: string[] = [];

  constructor(where: string) {
    this.#where = where;
  }

  #get(o: Obj, key: string, path: string, options: FieldOptions): unknown {
    if (!(key in o)) {
      if (options.optional !== true) this.#errors.push(`${path}${key} missing`);
      return undefined;
    }
    const value = o[key];
    if (value === null && options.nullable !== true) this.#errors.push(`${path}${key} is null`);
    return value;
  }

  str(o: Obj, key: string, options: FieldOptions & { enum?: readonly string[] } = {}, path = '') {
    const value = this.#get(o, key, path, options);
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      this.#errors.push(`${path}${key} not a string`);
      return null;
    }
    if (options.enum !== undefined && !options.enum.includes(value)) {
      this.#errors.push(`${path}${key} outside its enum`);
    }
    return value;
  }

  /** An integer (amounts are integer fen); returned as bigint so sums stay exact. */
  int(o: Obj, key: string, options: FieldOptions & { min?: number } = {}, path = '') {
    const value = this.#get(o, key, path, options);
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      this.#errors.push(`${path}${key} not an integer`);
      return null;
    }
    if (options.min !== undefined && value < options.min)
      this.#errors.push(`${path}${key} below ${String(options.min)}`);
    return BigInt(value);
  }

  bool(o: Obj, key: string, options: FieldOptions = {}, path = '') {
    const value = this.#get(o, key, path, options);
    if (value === undefined || value === null) return null;
    if (typeof value !== 'boolean') this.#errors.push(`${path}${key} not a boolean`);
    return value === true;
  }

  obj(o: Obj, key: string, options: FieldOptions = {}, path = ''): Obj | null {
    const value = this.#get(o, key, path, options);
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.#errors.push(`${path}${key} not an object`);
      return null;
    }
    return value as Obj;
  }

  arr(o: Obj, key: string, options: FieldOptions & { max?: number } = {}, path = ''): unknown[] {
    const value = this.#get(o, key, path, options);
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.#errors.push(`${path}${key} not an array`);
      return [];
    }
    if (options.max !== undefined && value.length > options.max) {
      this.#errors.push(`${path}${key} longer than ${String(options.max)}`);
    }
    return value;
  }

  /** Each element must be an object; non-objects are reported and dropped. */
  objects(items: unknown[], path: string): Obj[] {
    const out: Obj[] = [];
    items.forEach((item, index) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        this.#errors.push(`${path}[${String(index)}] not an object`);
      } else out.push(item as Obj);
    });
    return out;
  }

  error(text: string): void {
    this.#errors.push(text);
  }

  /** Fails the step when anything did not match (at most 8 field paths are listed). */
  done(): void {
    if (this.#errors.length === 0) return;
    const shown = this.#errors.slice(0, 8).join(', ');
    const more = this.#errors.length > 8 ? ` (+${String(this.#errors.length - 8)} more)` : '';
    throw new Fail(`${this.#where}: response does not match the contract: ${shown}${more}`);
  }
}

export const WITHDRAWAL_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'PAYING',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
] as const;

export const UNION_PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const;

/** The fields of WithdrawalSummary (Withdrawal adds channel_order_id). */
export function checkWithdrawal(shape: Shape, w: Obj, path: string, detail: boolean) {
  const nullableTimes = [
    'review_deadline',
    'executed_at',
    'first_attempt_at',
    'paid_at',
    'confirm_deadline',
  ];
  const id = shape.str(w, 'withdrawal_id', {}, path);
  const status = shape.str(w, 'status', { enum: WITHDRAWAL_STATUSES }, path);
  shape.str(w, 'review_mode', { nullable: true, enum: ['auto', 'manual'] }, path);
  const amount = shape.int(w, 'amount_fen', {}, path);
  shape.int(w, 'fee_fen', {}, path);
  shape.int(w, 'tax_fen', {}, path);
  const net = shape.int(w, 'net_fen', {}, path);
  shape.str(w, 'payout_channel', { enum: ['alipay', 'bank_card', 'wechat'] }, path);
  shape.str(w, 'payout_channel_name', {}, path);
  shape.str(w, 'masked_account', {}, path);
  shape.str(w, 'reason_code', { nullable: true }, path);
  shape.str(w, 'fail_action', { nullable: true }, path);
  shape.str(w, 'created_at', {}, path);
  for (const key of nullableTimes) shape.str(w, key, { nullable: true }, path);
  shape.str(w, 'channel_state', { nullable: true }, path);
  shape.str(w, 'sub_text_branch', {}, path);
  shape.int(w, 'hold_days', { nullable: true, min: 1 }, path);
  if (detail) shape.str(w, 'channel_order_id', { nullable: true }, path);
  return { id, status, amount, net };
}

/** The core fields of ProductCard (search results and parse cards). */
export function checkProductCard(shape: Shape, card: Obj, path: string): void {
  shape.str(card, 'product_key', { nullable: true }, path);
  shape.str(card, 'item_ref', { nullable: true }, path);
  shape.str(card, 'platform', { enum: UNION_PLATFORMS }, path);
  shape.str(card, 'title', { nullable: true }, path);
  shape.str(card, 'image', { nullable: true }, path);
  for (const key of [
    'price_fen',
    'coupon_fen',
    'final_price_fen',
    'est_net_price_fen',
    'rebate_min_fen',
    'rebate_max_fen',
  ]) {
    shape.int(card, key, { nullable: true }, path);
  }
  shape.str(
    card,
    'rebate_basis',
    { enum: ['normal', 'price_compare_risk', 'no_rebate', 'amount_unknown', 'login_required'] },
    path,
  );
  shape.arr(card, 'benefit_tags', {}, path);
  shape.bool(card, 'is_presale', {}, path);
  shape.str(card, 'link_id', {}, path);
  shape.obj(card, 'cta', {}, path);
  shape.str(card, 'quoted_at', { nullable: true }, path);
  shape.bool(card, 'stale', {}, path);
  shape.int(card, 'age_sec', { nullable: true }, path);
  shape.str(card, 'source', { enum: ['taobao_union', 'jd_union', 'pdd_union'] }, path);
  shape.arr(card, 'disclaimer_keys', {}, path);
  shape.str(
    card,
    'availability',
    { enum: ['ok', 'off_shelf', 'coupon_gone', 'ref_expired', 'price_unavailable', 'unknown'] },
    path,
  );
}
