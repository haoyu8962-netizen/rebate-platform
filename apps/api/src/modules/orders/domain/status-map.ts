// 平台状态映射（BR-FUND-02；规划/02 §7.2）：specs/order-status-map/<platform>.csv 把平台原始状态码
// 映射为内部事件 PLATFORM_*。本文件是纯函数：不读文件、不写库；csv 由装配层在模块启动时读一次后传入，
// 文件不存在时传 null（报 MISSING_STATUS_MAP）。表外码一律返回 unmapped，由调用方写 UNMAPPED_STATUS
// 待处理记录与 hold；这里不猜测任何码，也不做 trim / 大小写 / 数值归一。
//
// TODO(规划/11 §4.5): 拼多多处罚类码 4（审核失败）/ 10（已处罚）进 pdd.csv（映射为 PLATFORM_PUNISH）
//   — blocked on CAP-PDD-07 实测；实测前它们不进表，出现时按表外码处理（BR-FUND-02）。

export type PlatformStatusEvent =
  | 'PLATFORM_DEPOSIT_PAID'
  | 'PLATFORM_PAID'
  | 'PLATFORM_RECEIVED'
  | 'PLATFORM_SETTLED'
  | 'PLATFORM_INVALID'
  | 'PLATFORM_PUNISH'
  | 'PLATFORM_RIGHTS';

export interface StatusMapEntry {
  readonly event: PlatformStatusEvent;
  readonly source: string;
  readonly verified: boolean;
  readonly note: string;
}

export interface StatusMap {
  readonly platform: string;
  readonly entries: ReadonlyMap<string, StatusMapEntry>;
}

export type PlatformStatusMapping =
  | { readonly kind: 'event'; readonly event: PlatformStatusEvent; readonly verified: boolean }
  | { readonly kind: 'unmapped'; readonly rawCode: string | null };

const EVENTS: ReadonlySet<string> = new Set<PlatformStatusEvent>([
  'PLATFORM_DEPOSIT_PAID',
  'PLATFORM_PAID',
  'PLATFORM_RECEIVED',
  'PLATFORM_SETTLED',
  'PLATFORM_INVALID',
  'PLATFORM_PUNISH',
  'PLATFORM_RIGHTS',
]);

const HEADER = ['raw_code', 'event', 'source', 'verified', 'note'] as const;

/** 映射表错误；code 为 MISSING_STATUS_MAP 或 INVALID_STATUS_MAP（B1-08n：装配层据 code 判定启动失败原因）。 */
export class StatusMapError extends Error {
  override readonly name = 'StatusMapError';
  readonly code: 'MISSING_STATUS_MAP' | 'INVALID_STATUS_MAP';

  constructor(code: 'MISSING_STATUS_MAP' | 'INVALID_STATUS_MAP', message: string) {
    super(message);
    this.code = code;
  }
}

function fail(
  platform: string,
  code: 'MISSING_STATUS_MAP' | 'INVALID_STATUS_MAP',
  detail: string,
): never {
  throw new StatusMapError(code, `${code}: order-status-map/${platform}.csv ${detail}`);
}

/** 按 RFC 4180 拆行与字段（双引号包裹、"" 转义、CRLF / LF 换行）；引号不闭合或引号后跟杂字符即报错。 */
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
      fail(platform, 'INVALID_STATUS_MAP', `第 ${rows.length + 1} 行引号或换行格式错误`);
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) fail(platform, 'INVALID_STATUS_MAP', '引号未闭合');
  if (field !== '' || row.length > 0 || afterQuote) endRow();
  // 只容许文件末尾的空行（编辑器常见的结尾换行）；中间的空行视为坏行。
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.length === 1 &&
    rows[rows.length - 1]![0] === ''
  ) {
    rows.pop();
  }
  return rows;
}

function parseVerified(platform: string, line: number, value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fail(platform, 'INVALID_STATUS_MAP', `第 ${line} 行 verified 只能是 true 或 false`);
}

/**
 * 解析并严格校验某平台的状态映射表。csvText 为 null 表示该平台没有映射表（读取层传入），报 MISSING_STATUS_MAP；
 * 表头必须恰为 raw_code,event,source,verified,note；事件只能是 PLATFORM_* 七个编码之一；raw_code 不得为空或重复。
 */
export function loadStatusMap(platform: string, csvText: string | null): StatusMap {
  if (csvText === null) fail(platform, 'MISSING_STATUS_MAP', '不存在');
  const text = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const rows = parseCsv(platform, text);
  const [header, ...data] = rows;
  if (header === undefined) fail(platform, 'INVALID_STATUS_MAP', '为空');
  if (header.length !== HEADER.length || header.some((name, idx) => name !== HEADER[idx])) {
    fail(platform, 'INVALID_STATUS_MAP', `表头必须是 ${HEADER.join(',')}`);
  }
  if (data.length === 0) fail(platform, 'INVALID_STATUS_MAP', '没有数据行');
  const entries = new Map<string, StatusMapEntry>();
  data.forEach((cols, idx) => {
    const line = idx + 2;
    if (cols.length !== HEADER.length) {
      fail(platform, 'INVALID_STATUS_MAP', `第 ${line} 行应为 ${HEADER.length} 列`);
    }
    const [rawCode, event, source, verified, note] = cols as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (rawCode === '') fail(platform, 'INVALID_STATUS_MAP', `第 ${line} 行 raw_code 为空`);
    if (!EVENTS.has(event)) {
      fail(
        platform,
        'INVALID_STATUS_MAP',
        `第 ${line} 行事件 ${JSON.stringify(event)} 不是 PLATFORM_* 编码`,
      );
    }
    if (source === '') fail(platform, 'INVALID_STATUS_MAP', `第 ${line} 行 source 为空`);
    if (entries.has(rawCode)) {
      fail(
        platform,
        'INVALID_STATUS_MAP',
        `第 ${line} 行 raw_code ${JSON.stringify(rawCode)} 重复`,
      );
    }
    entries.set(
      rawCode,
      Object.freeze({
        event: event as PlatformStatusEvent,
        source,
        verified: parseVerified(platform, line, verified),
        note,
      }),
    );
  });
  return Object.freeze({ platform, entries });
}

/** 原始码按表精确查找；null 或表外码返回 unmapped（保留原码），由调用方按 UNMAPPED_STATUS 处理。 */
export function mapPlatformStatus(map: StatusMap, rawCode: string | null): PlatformStatusMapping {
  if (rawCode === null) return { kind: 'unmapped', rawCode };
  const entry = map.entries.get(rawCode);
  if (entry === undefined) return { kind: 'unmapped', rawCode };
  return { kind: 'event', event: entry.event, verified: entry.verified };
}
