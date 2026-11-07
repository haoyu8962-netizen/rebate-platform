// B2-04zze: the automatic order sub-reason table (08 BR-TEXT-05「子原因 reason_sub」细则「写入来源 ①」;
// orchestrator D10-818 ②, D10-862). specs/reason-sub-map/<platform>.csv maps the union's violation
// text (Taobao / 大淘客 violation_type) to a PUNISH sub-reason by exact match on the 08 desc. Pure
// functions, as domain/status-map.ts: no file read, no write, no log; the assembly reads the csv
// once at start and passes its text in. A value outside the table (code shapes such as "1" / "2",
// the empty string, null) is unmapped and never guessed: no trim, no case or width folding; the
// caller writes PUNISH_ORDER and raises the order_reason_sub_unmapped alert.
import type { OrderReasonSub } from '@couli/contracts-ts';

/** One platform's violation text → PUNISH sub-reason table, as loaded from its csv. */
export interface ReasonSubMap {
  readonly platform: string;
  readonly entries: ReadonlyMap<string, OrderReasonSub>;
}

/** The result of one exact lookup; unmapped keeps the raw value for the alert. */
export type ViolationTypeMapping =
  | { readonly kind: 'mapped'; readonly sub: OrderReasonSub }
  | { readonly kind: 'unmapped'; readonly raw: string | null };

/**
 * The PUNISH sub-reasons a table row may name (contracts/enums/order.yaml order_reason_sub, parent
 * PUNISH). PUNISH_ORDER is the fallback of an unmapped text, never a table value.
 */
const TABLE_SUBS: ReadonlySet<string> = new Set<OrderReasonSub>([
  'VIOLATION_PROMO',
  'SHOP_TK',
  'INSITE_PROMO',
  'PROXY_BUY',
  'FAKE_TRADE',
  'INSITE_RESALE',
  'OVER_LIMIT',
  'MARKET_DISRUPT',
  'MULTI_TRADE_ABNORMAL',
  'SINGLE_TRADE_ABNORMAL',
  'RISK_ORDER',
]);

const HEADER = ['violation_type', 'reason_sub', 'source', 'verified', 'note'] as const;

/** A table error; the assembly refuses to start on either code. */
export class ReasonSubMapError extends Error {
  override readonly name = 'ReasonSubMapError';
  readonly code: 'MISSING_REASON_SUB_MAP' | 'INVALID_REASON_SUB_MAP';

  constructor(code: 'MISSING_REASON_SUB_MAP' | 'INVALID_REASON_SUB_MAP', message: string) {
    super(message);
    this.code = code;
  }
}

function fail(
  platform: string,
  code: 'MISSING_REASON_SUB_MAP' | 'INVALID_REASON_SUB_MAP',
  detail: string,
): never {
  throw new ReasonSubMapError(code, `${code}: reason-sub-map/${platform}.csv ${detail}`);
}

/** RFC 4180 rows and fields (double quotes, "" escape, CRLF / LF), as domain/status-map.ts. */
function parseCsv(platform: string, text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let afterQuote = false;
  const endField = (): void => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      endRow();
      i += 2;
    } else if (ch === '\n') {
      endRow();
      i += 1;
    } else if (ch === '"' && field === '' && !afterQuote) {
      quoted = true;
      i += 1;
    } else if (afterQuote || ch === '"' || ch === '\r') {
      fail(platform, 'INVALID_REASON_SUB_MAP', `line ${rows.length + 1}: bad quote or line break`);
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) fail(platform, 'INVALID_REASON_SUB_MAP', 'unclosed quote');
  if (field !== '' || row.length > 0 || afterQuote) endRow();
  // Only trailing empty lines are tolerated (an editor's final newline).
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.length === 1 &&
    rows[rows.length - 1]![0] === ''
  ) {
    rows.pop();
  }
  return rows;
}

/**
 * Parses and checks one platform's table (csvText null: the platform has no file →
 * MISSING_REASON_SUB_MAP). Header exactly violation_type,reason_sub,source,verified,note; every
 * reason_sub one of the 11 PUNISH sub-reasons (not PUNISH_ORDER); violation_type nonempty and not
 * repeated; source nonempty; verified true / false. Any bad row refuses the whole table.
 */
export function loadReasonSubMap(platform: string, csvText: string | null): ReasonSubMap {
  if (csvText === null) fail(platform, 'MISSING_REASON_SUB_MAP', 'does not exist');
  const text = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const [header, ...data] = parseCsv(platform, text);
  if (header === undefined) fail(platform, 'INVALID_REASON_SUB_MAP', 'is empty');
  if (header.length !== HEADER.length || header.some((name, idx) => name !== HEADER[idx])) {
    fail(platform, 'INVALID_REASON_SUB_MAP', `header must be ${HEADER.join(',')}`);
  }
  if (data.length === 0) fail(platform, 'INVALID_REASON_SUB_MAP', 'has no data rows');
  const entries = new Map<string, OrderReasonSub>();
  data.forEach((cols, idx) => {
    const line = idx + 2;
    if (cols.length !== HEADER.length) {
      fail(platform, 'INVALID_REASON_SUB_MAP', `line ${line}: expected ${HEADER.length} fields`);
    }
    const [violationType, sub, source, verified] = cols as [string, string, string, string];
    if (violationType === '') {
      fail(platform, 'INVALID_REASON_SUB_MAP', `line ${line}: empty violation_type`);
    }
    if (!TABLE_SUBS.has(sub)) {
      fail(
        platform,
        'INVALID_REASON_SUB_MAP',
        `line ${line}: ${JSON.stringify(sub)} is not a PUNISH sub-reason of the table`,
      );
    }
    if (source === '') fail(platform, 'INVALID_REASON_SUB_MAP', `line ${line}: empty source`);
    if (verified !== 'true' && verified !== 'false') {
      fail(platform, 'INVALID_REASON_SUB_MAP', `line ${line}: verified must be true or false`);
    }
    if (entries.has(violationType)) {
      fail(platform, 'INVALID_REASON_SUB_MAP', `line ${line}: repeated violation_type`);
    }
    entries.set(violationType, sub as OrderReasonSub);
  });
  return Object.freeze({ platform, entries });
}

/** Exact lookup of the union's violation text; null or a value outside the table → unmapped. */
export function mapViolationType(map: ReasonSubMap, raw: string | null): ViolationTypeMapping {
  if (raw === null) return { kind: 'unmapped', raw };
  const sub = map.entries.get(raw);
  if (sub === undefined) return { kind: 'unmapped', raw };
  return { kind: 'mapped', sub };
}
