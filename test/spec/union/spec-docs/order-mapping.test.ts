// B1-18a (D10-1225, BR-CALC-03): the order mapping documents specs/union/taobao.md and
// specs/union/pdd.md, in the shape of specs/union/jd.md (jd.md itself is kept by another task and is
// not asserted here). The tests read the real files: the documents, the union domain types and the
// two order adapters. The DTO field list comes from apps/api/src/modules/union/domain/types.ts
// through the TypeScript AST, never from a copy here. Every test first asserts that the document
// (and the section it needs) exists, so a missing document fails as an assertion.
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const TYPES_PATH = 'apps/api/src/modules/union/domain/types.ts';
const SCHEMA_PATH = 'db/schema.sql';
const HEADER = ['DTO 字段', '报文字段', '说明'];
/** BR-CALC-03: N is the estimate and the settlement commission of the DTO. */
const N_DTO_FIELDS = ['est_commission_fen', 'settle_commission_fen'];

/** BR-CALC-03: a DTO amount the adapter computes as wire commission minus wire service fee. */
interface Deduction {
  readonly dto: 'est_commission_fen' | 'settle_commission_fen';
  readonly commission: string;
  readonly fee: string;
}

interface PlatformCase {
  readonly platform: 'taobao' | 'pdd';
  readonly doc: string;
  readonly adapter: string;
  readonly fieldsInterface: 'TaobaoOrderFields' | 'PddOrderFields';
  /** BR-CALC-03: wire fields N is taken from in the adapter (gross commission, service fee). */
  readonly nFields: readonly string[];
  /** The adapter's N formulas (read from orders.ts before writing them down here). */
  readonly deductions: readonly Deduction[];
  /** Service fee fields used only as a fallback; not required on the formula line, never added. */
  readonly feeFallbacks: readonly string[];
  /** N fields the adapter never fills (always null). */
  readonly alwaysNull: readonly Deduction['dto'][];
}

const CASES: readonly PlatformCase[] = [
  {
    platform: 'taobao',
    doc: 'specs/union/taobao.md',
    adapter: 'apps/api/src/modules/union/infra/taobao/orders.ts',
    fieldsInterface: 'TaobaoOrderFields',
    nFields: [
      'pub_share_pre_fee_for_commission',
      'pub_share_fee_for_commission',
      'alimm_tech_service_pre_fee',
      'alimm_tech_service_fee',
      'alimama_share_fee',
    ],
    // taobao/orders.ts:20-27, 110-113, 927-943: each side nets its own alimm_share_info_dto fee;
    // alimama_share_fee is only the fallback when the dto field has no value.
    deductions: [
      {
        dto: 'est_commission_fen',
        commission: 'pub_share_pre_fee_for_commission',
        fee: 'alimm_tech_service_pre_fee',
      },
      {
        dto: 'settle_commission_fen',
        commission: 'pub_share_fee_for_commission',
        fee: 'alimm_tech_service_fee',
      },
    ],
    feeFallbacks: ['alimama_share_fee'],
    alwaysNull: [],
  },
  {
    platform: 'pdd',
    doc: 'specs/union/pdd.md',
    adapter: 'apps/api/src/modules/union/infra/pdd/orders.ts',
    fieldsInterface: 'PddOrderFields',
    nFields: ['promotion_amount', 'duo_id_service_fee'],
    // pdd/orders.ts:404-407, 489-491: est = promotion_amount − duo_id_service_fee; settle is null.
    deductions: [
      { dto: 'est_commission_fen', commission: 'promotion_amount', fee: 'duo_id_service_fee' },
    ],
    feeFallbacks: [],
    alwaysNull: ['settle_commission_fen'],
  },
];

const unique = (values: readonly string[]): string[] => [...new Set(values)];

// ---------------------------------------------------------------------------------------------
// Markdown (plain line splitting, no dependency)
// ---------------------------------------------------------------------------------------------

function readDoc(doc: string): string {
  const url = new URL(doc, ROOT);
  const exists = existsSync(url);
  expect(exists, `${doc} 应存在`).toBe(true);
  return exists ? readFileSync(url, 'utf8') : '';
}

/** Lines of the document with fenced code blocks blanked (headings and tables are outside them). */
function unfenced(text: string): string[] {
  let fenced = false;
  return text.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

function headingOf(line: string): { readonly level: number; readonly text: string } | null {
  const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
  if (match === null) return null;
  return { level: (match[1] ?? '').length, text: match[2] ?? '' };
}

/**
 * The body of every section opened by a heading of `level` whose text passes `test`, up to the
 * next heading of that level or higher.
 */
function sections(
  lines: readonly string[],
  level: number,
  test: (text: string) => boolean,
): string[][] {
  const found: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== null && heading.level <= level) {
      current = null;
      if (heading.level === level && test(heading.text)) {
        const body: string[] = [];
        found.push(body);
        current = body;
      }
      continue;
    }
    current?.push(line);
  }
  return found;
}

/** The level-one sections whose title contains 订单映射. */
function orderSections(text: string): string[][] {
  return sections(unfenced(text), 1, (title) => title.includes('订单映射'));
}

function cells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

interface Table {
  readonly header: readonly string[];
  readonly separatorOk: boolean;
  readonly rows: readonly (readonly string[])[];
}

/** The first table of the order section's `## 字段对照`, or null when there is none. */
function fieldTable(orderLines: readonly string[]): Table | null {
  const sub = sections(orderLines, 2, (title) => title === '字段对照');
  if (sub.length !== 1) return null;
  const lines = sub[0] ?? [];
  const start = lines.findIndex((line) => line.trim().startsWith('|'));
  if (start < 0) return null;
  const rows: string[][] = [];
  for (let at = start; at < lines.length && (lines[at] ?? '').trim().startsWith('|'); at += 1) {
    rows.push(cells(lines[at] ?? ''));
  }
  const separator = rows[1] ?? [];
  return {
    header: rows[0] ?? [],
    separatorOk: separator.length > 0 && separator.every((cell) => /^:?-{3,}:?$/.test(cell)),
    rows: rows.slice(2),
  };
}

/** The rows of the order field table; asserts the section and the header first. */
function requireFieldRows(doc: string): readonly (readonly string[])[] {
  const order = orderSections(readDoc(doc));
  expect(order, `${doc}：一级标题含「订单映射」的段`).toHaveLength(1);
  const table = fieldTable(order[0] ?? []);
  expect(table?.header, `${doc}：订单映射段下 ## 字段对照 的表头`).toEqual(HEADER);
  return table?.rows ?? [];
}

/** Dotted identifier names inside the backtick spans of `text` (`a − b` gives both names). */
function namesIn(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].flatMap(
    (span) => (span[1] ?? '').match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [],
  );
}

/** The body lines of the order section's `## 金额`; asserts the section and the subsection first. */
function requireMoneyLines(doc: string): readonly string[] {
  const order = orderSections(readDoc(doc));
  expect(order, `${doc}：一级标题含「订单映射」的段`).toHaveLength(1);
  const money = sections(order[0] ?? [], 2, (title) => title.startsWith('金额'));
  expect(money, `${doc}：订单映射段下的 ## 金额`).toHaveLength(1);
  return money[0] ?? [];
}

/** One identifier named inside a backtick span of a line, with its offsets. */
interface Mention {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly spanStart: number;
  readonly spanEnd: number;
}

function mentionsIn(line: string): Mention[] {
  const found: Mention[] = [];
  const spanPattern = /`([^`]+)`/g;
  for (let span = spanPattern.exec(line); span !== null; span = spanPattern.exec(line)) {
    const inner = span[1] ?? '';
    const spanStart = span.index;
    const idPattern = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
    for (let id = idPattern.exec(inner); id !== null; id = idPattern.exec(inner)) {
      const start = spanStart + 1 + id.index;
      found.push({
        name: id[0],
        start,
        end: start + id[0].length,
        spanStart,
        spanEnd: spanStart + span[0].length,
      });
    }
  }
  return found;
}

/** A mention names `field` itself or a dotted path ending in it (dto.field). */
function refersTo(mention: Mention, field: string): boolean {
  return mention.name === field || mention.name.endsWith(`.${field}`);
}

/** The prose between two mentions (a before b), other backtick spans blanked out. */
function between(line: string, a: Mention, b: Mention): string {
  if (a.spanStart === b.spanStart) return line.slice(a.end, b.start);
  return line.slice(a.spanEnd, b.spanStart).replace(/`[^`]*`/g, ' ');
}

/** 9.4 ①: an explicit deduction between commission and fee (−, -, 减, 扣除, 扣减). */
const DEDUCT = /[−-]|减|扣除/;
const PLUS = /[+＋]/;
/** Commission and fee must sit close: a formula, not two fields of unrelated sentences. */
const MAX_GAP = 40;

/** A line that writes `dto` as `commission` minus `fee`, with nothing added between them. */
function deducts(line: string, deduction: Deduction): boolean {
  const mentions = mentionsIn(line);
  if (!mentions.some((mention) => refersTo(mention, deduction.dto))) return false;
  return mentions.some(
    (commission) =>
      refersTo(commission, deduction.commission) &&
      mentions.some((fee) => {
        if (!refersTo(fee, deduction.fee) || fee.start < commission.end) return false;
        const gap = between(line, commission, fee);
        return [...gap].length <= MAX_GAP && DEDUCT.test(gap) && !PLUS.test(gap);
      }),
  );
}

/** Every commission / fee pair of a line joined by a plus sign, in either order. */
function additions(
  line: string,
  commissions: readonly string[],
  fees: readonly string[],
): string[] {
  const mentions = mentionsIn(line);
  const isCommission = (mention: Mention): boolean =>
    commissions.some((field) => refersTo(mention, field));
  const isFee = (mention: Mention): boolean => fees.some((field) => refersTo(mention, field));
  const found: string[] = [];
  for (const a of mentions) {
    for (const b of mentions) {
      if (b.start < a.end) continue;
      const pair = (isCommission(a) && isFee(b)) || (isFee(a) && isCommission(b));
      if (pair && PLUS.test(between(line, a, b))) found.push(`${a.name} + ${b.name}`);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// TypeScript sources
// ---------------------------------------------------------------------------------------------

function parseTs(path: string): ts.SourceFile {
  const text = readFileSync(new URL(path, ROOT), 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function visit(node: ts.Node, each: (node: ts.Node) => void): void {
  each(node);
  node.forEachChild((child) => visit(child, each));
}

function nameText(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return null;
}

function interfaceOf(source: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  return source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
}

/**
 * The property names an interface of types.ts declares itself (not inherited). A property typed
 * as another interface of the same file is spread into dotted paths (attr_params.relation_id …).
 */
function declaredFields(source: ts.SourceFile, name: string): string[] {
  const declaration = interfaceOf(source, name);
  expect(declaration, `${TYPES_PATH} 里的 interface ${name}`).toBeDefined();
  const fields: string[] = [];
  for (const member of declaration?.members ?? []) {
    if (!ts.isPropertySignature(member)) continue;
    const field = nameText(member.name);
    if (field === null) continue;
    const type = member.type;
    const nested =
      type !== undefined && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
        ? interfaceOf(source, type.typeName.text)
        : undefined;
    if (nested === undefined) fields.push(field);
    else fields.push(...declaredFields(source, nested.name.text).map((sub) => `${field}.${sub}`));
  }
  expect(fields.length, `interface ${name} 的字段`).toBeGreaterThan(0);
  return fields;
}

/** 9.1 ②: neutral fields (attr_params spread), UnionOrder's own fields, the platform's fields. */
function requiredDtoFields(fieldsInterface: string): string[] {
  const types = parseTs(TYPES_PATH);
  return unique([
    ...declaredFields(types, 'UnionOrderNeutralFields'),
    ...declaredFields(types, 'UnionOrder'),
    ...declaredFields(types, fieldsInterface),
  ]);
}

interface SourceNames {
  readonly strings: ReadonlySet<string>;
  readonly properties: ReadonlySet<string>;
}

const DOTTED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/** String literal texts and property names of an adapter source (comments do not count). */
function sourceNames(path: string): SourceNames {
  const strings = new Set<string>();
  const properties = new Set<string>();
  visit(parseTs(path), (node) => {
    if (ts.isStringLiteralLike(node)) {
      strings.add(node.text);
      if (DOTTED.test(node.text)) for (const part of node.text.split('.')) strings.add(part);
    }
    let name: string | null = null;
    if (ts.isPropertyAccessExpression(node)) name = nameText(node.name);
    else if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node)
    ) {
      name = nameText(node.name);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      name = nameText(node.propertyName ?? node.name);
    }
    if (name !== null) properties.add(name);
  });
  return { strings, properties };
}

/** A name is in the source as a string or a property name; a dotted path whole or by segments. */
function present(name: string, source: SourceNames): boolean {
  const has = (part: string): boolean => source.strings.has(part) || source.properties.has(part);
  if (has(name)) return true;
  const parts = name.split('.');
  return parts.length > 1 && parts.every(has);
}

/** A wire field written in prose: lower snake_case (dotted paths allowed). */
const WIRE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)*$/;

/**
 * Our own names, which are not wire fields: every property declared in types.ts and every
 * identifier of db/schema.sql outside comments and string literals. Metric names start with
 * couli_ and are left out separately.
 */
function ourNames(): ReadonlySet<string> {
  const names = new Set<string>();
  visit(parseTs(TYPES_PATH), (node) => {
    if (!ts.isPropertySignature(node)) return;
    const name = nameText(node.name);
    if (name !== null) names.add(name);
  });
  const schema = readFileSync(new URL(SCHEMA_PATH, ROOT), 'utf8');
  for (const line of schema.split('\n')) {
    const code = line.replace(/'(?:[^']|'')*'/g, ' ').replace(/--.*$/, '');
    for (const word of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) names.add(word.toLowerCase());
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// Secrecy
// ---------------------------------------------------------------------------------------------

/** Sources whose own identifiers (interfaces, columns, alert names …) are not credentials. */
const OWN_SOURCES = [
  TYPES_PATH,
  SCHEMA_PATH,
  'infra/monitoring/rules/couli.yaml',
  ...CASES.map((entry) => entry.adapter),
];

/** Every word of OWN_SOURCES (e.g. UnionOrderNeutralFields, CouliPddServiceFeeMissing). */
function ownWords(): ReadonlySet<string> {
  const words = new Set<string>();
  for (const path of OWN_SOURCES) {
    const text = readFileSync(new URL(path, ROOT), 'utf8');
    for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) words.add(word);
  }
  return words;
}

/** 9.4 ③: a whole token that is a file path (has `/`, every segment [a-z0-9._-]) is not a leak. */
function isPath(token: string): boolean {
  const segments = token.split('/').filter((segment) => segment !== '');
  return (
    token.includes('/') &&
    segments.length > 0 &&
    segments.every((segment) => /^[a-z0-9._-]+$/.test(segment))
  );
}

/**
 * 9.4 ③: a run of ≥ 20 base64 characters holding at least two of upper case / lower case /
 * digits, unless its whole token is a file path or it is a word our own sources declare.
 */
function base64Leak(line: string, own: ReadonlySet<string>): boolean {
  for (const token of line.match(/[A-Za-z0-9+/=._-]+/g) ?? []) {
    if (isPath(token)) continue;
    for (const run of token.match(/[A-Za-z0-9+/]{20,}/g) ?? []) {
      const classes = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((kind) => kind.test(run)).length;
      if (classes >= 2 && !own.has(run)) return true;
    }
  }
  return false;
}

const LEAKS: readonly {
  readonly label: string;
  readonly test: (line: string, own: ReadonlySet<string>) => boolean;
}[] = [
  { label: '淘宝推广位 mm_<数字>_<数字>_<数字>', test: (line) => /mm_\d+_\d+_\d+/.test(line) },
  {
    label: '拼多多 PID <数字>_<数字>',
    test: (line) => /(?<!\w)\d+_\d+(?!\w)/.test(line),
  },
  {
    label: '长度 ≥ 20 的十六进制串',
    test: (line) => /(?<![0-9A-Za-z])[0-9A-Fa-f]{20,}(?![0-9A-Za-z])/.test(line),
  },
  { label: '长度 ≥ 20 的 base64 串', test: base64Leak },
  {
    label: 'app_secret / client_secret 后跟取值',
    test: (line) =>
      /\b(?:app|client)_secret\b["'`]?\s*[:=：]\s*["'`]?[A-Za-z0-9+/=_.-]{4,}/i.test(line),
  },
  { label: '```json 代码块', test: (line) => /^\s*(```|~~~)\s*json\b/i.test(line) },
  {
    label: '录制不以 rebate-private/cap-tests/... 路径引用',
    test: (line) =>
      (line.match(/[\w./-]*cap-tests\//g) ?? []).some(
        (prefix) => prefix !== 'rebate-private/cap-tests/',
      ),
  },
];

/** Line number and kind of each leak; never the leaked value itself. */
function leaks(text: string): string[] {
  const own = ownWords();
  return text
    .split(/\r?\n/)
    .flatMap((line, at) =>
      LEAKS.filter((leak) => leak.test(line, own)).map((leak) => `第 ${at + 1} 行：${leak.label}`),
    );
}

// ---------------------------------------------------------------------------------------------
// Rule tests
// ---------------------------------------------------------------------------------------------

it.each(CASES)(
  '[AC-B1-18a#1] $doc：有且仅有一个一级标题含「订单映射」的段，其下 ## 字段对照 表头依次为 DTO 字段 | 报文字段 | 说明',
  ({ doc }) => {
    const order = orderSections(readDoc(doc));
    expect(order, '一级标题含「订单映射」的段').toHaveLength(1);
    const tables = sections(order[0] ?? [], 2, (title) => title === '字段对照');
    expect(tables, '订单映射段下的 ## 字段对照').toHaveLength(1);
    const table = fieldTable(order[0] ?? []);
    expect(table, '## 字段对照 下的表格').not.toBeNull();
    expect(table?.header).toEqual(HEADER);
    expect(table?.separatorOk, '表头下的分隔行').toBe(true);
    expect(table?.rows.length ?? 0, '表格行数').toBeGreaterThan(0);
    for (const row of table?.rows ?? []) expect(row, `三列：${row.join(' | ')}`).toHaveLength(3);
  },
);

it.each(CASES)(
  '[AC-B1-18a#2] $doc：字段对照的 DTO 字段列覆盖平台无关字段（attr_params 展开为点路径）、UnionOrder 自身字段与 $fieldsInterface 全部字段，清单读自 types.ts',
  ({ doc, fieldsInterface }) => {
    const required = requiredDtoFields(fieldsInterface);
    const covered = new Set(requireFieldRows(doc).flatMap((row) => namesIn(row[0] ?? '')));
    expect(
      required.filter((field) => !covered.has(field)),
      'DTO 字段列缺的字段',
    ).toEqual([]);
  },
);

it.each(CASES)(
  '[AC-B1-18a#3] $doc：报文字段列里反引号括起的每个字段名都在 $adapter 里以字符串或属性名出现',
  ({ doc, adapter }) => {
    const wire = requireFieldRows(doc).flatMap((row) => namesIn(row[1] ?? ''));
    expect(wire.length, '报文字段列写出的字段名').toBeGreaterThan(0);
    const source = sourceNames(adapter);
    expect(
      unique(wire.filter((name) => !present(name, source))),
      '适配器源码里没有的报文字段',
    ).toEqual([]);
  },
);

it.each(CASES)(
  '[AC-B1-18a#4] $doc：订单映射段有 ## 金额 小节，按 BR-CALC-03 写明 N 的取数字段；其中的报文字段都在 $adapter 里',
  ({ doc, adapter, nFields }) => {
    const order = orderSections(readDoc(doc));
    expect(order, '一级标题含「订单映射」的段').toHaveLength(1);
    const money = sections(order[0] ?? [], 2, (title) => title.startsWith('金额'));
    expect(money, '订单映射段下的 ## 金额').toHaveLength(1);
    const body = (money[0] ?? []).join('\n');
    expect(body, '金额小节引用 BR-CALC-03').toContain('BR-CALC-03');
    const names = namesIn(body);
    const mentioned = new Set(names.flatMap((name) => [name, ...name.split('.')]));
    expect(
      [...N_DTO_FIELDS, ...nFields].filter((field) => !mentioned.has(field)),
      '金额小节没写到的 N 取数字段',
    ).toEqual([]);
    const ours = ourNames();
    const source = sourceNames(adapter);
    const wire = names.filter(
      (name) => WIRE_SHAPE.test(name) && !ours.has(name) && !name.startsWith('couli_'),
    );
    expect(
      unique(wire.filter((name) => !present(name, source))),
      '金额小节里适配器源码没有的报文字段',
    ).toEqual([]);
  },
);

it.each(CASES)(
  '[AC-B1-18a#5] $doc：补齐的订单映射文档不泄密：无推广位 / PID 值、长十六进制或 base64 串、secret 取值、```json 报文，录制只以 rebate-private/cap-tests/... 引用',
  ({ doc }) => {
    const text = readDoc(doc);
    expect(orderSections(text), '一级标题含「订单映射」的段（补齐后的文档）').toHaveLength(1);
    expect(leaks(text)).toEqual([]);
  },
);

it.each(CASES)(
  '[AC-B1-18a#6] $doc：## 金额 里每个 N 公式在同一行写明「佣金字段 扣减 服务费字段」（−、-、减、扣除、扣减），口径同 $adapter；不得出现佣金与服务费相加；恒为 null 的 N 写明恒为 null',
  ({ deductions, feeFallbacks, alwaysNull, doc }) => {
    const lines = requireMoneyLines(doc);
    for (const deduction of deductions) {
      expect(
        lines.some((line) => deducts(line, deduction)),
        `同一行写 \`${deduction.dto}\` = \`${deduction.commission}\` 扣减 \`${deduction.fee}\``,
      ).toBe(true);
    }
    const commissions = deductions.map((deduction) => deduction.commission);
    const fees = [...deductions.map((deduction) => deduction.fee), ...feeFallbacks];
    expect(
      lines.flatMap((line) => additions(line, commissions, fees)),
      '金额小节里佣金与服务费相加的写法',
    ).toEqual([]);
    for (const dto of alwaysNull) {
      expect(
        lines.some(
          (line) =>
            mentionsIn(line).some((mention) => mention.name === dto) &&
            /恒为\s*null/.test(line.replace(/`/g, '')),
        ),
        `同一行写明 \`${dto}\` 恒为 null`,
      ).toBe(true);
    }
  },
);

/** 9.4 ②: what a row without a wire field must say. */
const UNMAPPED = /恒为\s*null|不给|不映射/;

it.each(CASES)(
  '[AC-B1-18a#7] $doc：字段对照每一行的说明列非空；报文字段列没有反引号字段名的行（不映射、恒为 null、平台不给），说明含「恒为 null」「不给」或「不映射」',
  ({ doc }) => {
    const rows = requireFieldRows(doc);
    expect(rows.length, '字段对照表格行数').toBeGreaterThan(0);
    expect(
      rows.filter((row) => !/[\p{L}\p{N}]/u.test(row[2] ?? '')).map((row) => row[0] ?? ''),
      '说明列为空的行',
    ).toEqual([]);
    expect(
      rows
        .filter(
          (row) =>
            namesIn(row[1] ?? '').length === 0 && !UNMAPPED.test((row[2] ?? '').replace(/`/g, '')),
        )
        .map((row) => row[0] ?? ''),
      '没有报文字段、说明也没写恒为 null / 不给 / 不映射的行',
    ).toEqual([]);
  },
);
