// B1-18b（BR-CALC-03 / BR-CALC-18，D10-1225）：specs/attribution.md 三平台 N 取数映射的只读一致性测试。
// 读真实文件，不用夹具：文档表格与三平台订单适配器源码、仓库路径逐项对账。
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const DOC = 'specs/attribution.md';
const HEADER = ['DTO 字段', '报文字段与公式', '取值时机', '实现位置'] as const;
const SEPARATOR = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const RECORDING_PATH = /^rebate-private\/cap-tests\/\S+$/;
const LINE_SUFFIX = /:\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*$/;
const LABEL_LEAD = /^\s*(?:#{1,6}\s+|[-*+]\s+|\|\s*)?(?:\*\*)?/;
const DEDUCTION = /[−-]|减|扣除/;
const IDENT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const HEX_20 = /(?<![0-9A-Za-z])[0-9a-fA-F]{20,}(?![0-9A-Za-z])/;
const BASE64_20 = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const PATH_PART = /^[a-z0-9._-]*$/;
const SECRET_VALUE = /(?:app_secret|client_secret)["'`]?\s*[:=：]\s*["'`]?[^\s"'`]+/i;

/** 佣金与服务费相加的写法（服务费在加号任一侧）。 */
const FEE_ADDITION = [
  /[+＋]\s*`?[^\s|`+＋]{0,30}?(?:服务费|service_fee|tech_service|alimama_share_fee)/,
  /(?:服务费|service_fee|tech_service_(?:pre_)?fee|alimama_share_fee)`?\s*[+＋]/,
];

// net：同一格内 gross 在前、fee 在后，两者之间写扣减；mentions：该行出现全部 terms；
// null：该行写「恒为 null」。
type Formula =
  | { readonly kind: 'net'; readonly gross: string; readonly fee: string }
  | { readonly kind: 'mentions'; readonly terms: readonly string[] }
  | { readonly kind: 'null' };

interface PlatformCase {
  readonly platform: string;
  readonly title: string;
  readonly source: string;
  readonly est: Formula;
  readonly settle: Formula;
}

const PLATFORMS: readonly PlatformCase[] = [
  {
    platform: 'jd',
    title: '京东',
    source: 'apps/api/src/modules/union/infra/jd/orders.ts',
    est: { kind: 'mentions', terms: ['actualFee', 'estimateFee'] },
    settle: { kind: 'null' },
  },
  {
    platform: 'taobao',
    title: '淘宝',
    source: 'apps/api/src/modules/union/infra/taobao/orders.ts',
    est: {
      kind: 'net',
      gross: 'pub_share_pre_fee_for_commission',
      fee: 'alimm_tech_service_pre_fee',
    },
    settle: {
      kind: 'net',
      gross: 'pub_share_fee_for_commission',
      fee: 'alimm_tech_service_fee',
    },
  },
  {
    platform: 'pdd',
    title: '拼多多',
    source: 'apps/api/src/modules/union/infra/pdd/orders.ts',
    est: { kind: 'net', gross: 'promotion_amount', fee: 'duo_id_service_fee' },
    settle: { kind: 'null' },
  },
];

interface Row {
  readonly dto: string;
  readonly formula: string;
  readonly timing: string;
  readonly location: string;
  readonly line: string;
}

function loadDoc(): string {
  const url = new URL(DOC, ROOT);
  expect(existsSync(url), `${DOC} 须存在`).toBe(true);
  return readFileSync(url, 'utf8');
}

/** 含 title 的二级标题下、到下一个一级或二级标题之前的正文。 */
function sectionOf(doc: string, title: string): string {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s/.test(line) && line.includes(title));
  expect(start, `须有含「${title}」的二级标题`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

function splitCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function isHeaderLine(line: string): boolean {
  if (!line.trim().startsWith('|')) return false;
  const cells = splitCells(line);
  return cells.length === HEADER.length && cells.every((cell, i) => cell === HEADER[i]);
}

/** 该节表头为 HEADER 的 N 取数表的数据行。 */
function nTable(section: string, title: string): Row[] {
  const lines = section.split('\n');
  const at = lines.findIndex(isHeaderLine);
  expect(at, `「${title}」节须有 N 取数表`).toBeGreaterThanOrEqual(0);
  const separator = lines[at + 1] ?? '';
  expect(separator, `「${title}」节表头下须是分隔行`).toMatch(SEPARATOR);
  const rows: Row[] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.trim().startsWith('|')) break;
    const [dto = '', formula = '', timing = '', location = ''] = splitCells(line);
    rows.push({ dto, formula, timing, location, line });
  }
  return rows;
}

function tableOf(c: PlatformCase): Row[] {
  return nTable(sectionOf(loadDoc(), c.title), c.title);
}

function rowOf(rows: readonly Row[], field: string, title: string): Row {
  const row = rows.find((r) => r.dto.includes(`\`${field}\``));
  expect(row, `「${title}」节须有 \`${field}\` 行`).toBeDefined();
  return row!;
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim());
}

function wordAt(text: string, word: string): RegExpExecArray | null {
  return new RegExp(`(?<!\\w)${word}(?!\\w)`).exec(text);
}

/** 反引号内整段是蛇形或驼峰字段名（含点路径）。 */
function isWireField(token: string): boolean {
  if (!IDENT_PATH.test(token)) return false;
  return token.split('.').some((segment) => SNAKE.test(segment) || CAMEL.test(segment));
}

/** 「报文字段与公式」列里反引号括起的报文字段名。 */
function wireFields(rows: readonly Row[]): string[] {
  return rows.flatMap((row) => backticked(row.formula)).filter(isWireField);
}

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateHead(node)) return node.text;
  if (ts.isTemplateMiddle(node)) return node.text;
  if (ts.isTemplateTail(node)) return node.text;
  return undefined;
}

/** parent 里作属性名的那个节点。 */
function propertyNameOf(parent: ts.Node): ts.Node | undefined {
  if (ts.isPropertyAccessExpression(parent)) return parent.name;
  if (ts.isPropertyAssignment(parent)) return parent.name;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name;
  if (ts.isPropertySignature(parent)) return parent.name;
  if (ts.isPropertyDeclaration(parent)) return parent.name;
  if (ts.isMethodDeclaration(parent)) return parent.name;
  if (ts.isMethodSignature(parent)) return parent.name;
  if (ts.isBindingElement(parent)) return parent.propertyName ?? parent.name;
  return undefined;
}

/** 源码里以字符串（含其中的标识符片段）或属性名出现的名字；注释不算。 */
function sourceNames(path: string): ReadonlySet<string> {
  const url = new URL(path, ROOT);
  expect(existsSync(url), `${path} 须存在`).toBe(true);
  const text = readFileSync(url, 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    const literal = literalText(node);
    if (literal !== undefined) {
      names.add(literal);
      for (const m of literal.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]);
    }
    if (ts.isIdentifier(node) && propertyNameOf(node.parent) === node) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function stripAnchor(path: string): string {
  return path.replace(/#.*$/, '').replace(LINE_SUFFIX, '');
}

/** 「实现位置」列里反引号括起、含 / 的路径（去掉行号后缀与锚点）。 */
function locationPaths(rows: readonly Row[]): string[] {
  const tokens = rows.flatMap((row) => backticked(row.location));
  return tokens.filter((token) => token.includes('/')).map(stripAnchor);
}

function expectFormula(row: Row, formula: Formula, field: string, title: string): void {
  const label = `「${title}」节 \`${field}\` 行`;
  if (formula.kind === 'null') {
    expect(row.line, `${label}须写「恒为 null」`).toMatch(/恒为\s*`?null`?/);
    return;
  }
  if (formula.kind === 'mentions') {
    for (const term of formula.terms) {
      expect(wordAt(row.line, term), `${label}须出现 ${term}`).not.toBeNull();
    }
    return;
  }
  const gross = wordAt(row.formula, formula.gross);
  expect(gross, `${label}须写 ${formula.gross}`).not.toBeNull();
  const after = row.formula.slice(gross!.index + formula.gross.length);
  const fee = wordAt(after, formula.fee);
  expect(fee, `${label}须在 ${formula.gross} 之后写 ${formula.fee}`).not.toBeNull();
  const between = after.slice(0, fee!.index);
  expect(between, `${label}须写扣减`).toMatch(DEDUCTION);
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

function notIndented(line: string): boolean {
  return !/^\s+\S/.test(line);
}

/** 以 label 开头的一行（标题、列表项、表格首格或普通行，允许加粗）。 */
function startsWithLabel(line: string, label: string): boolean {
  return line.replace(LABEL_LEAD, '').startsWith(label);
}

/** 标签行所在的块：标题 → 到下一个标题；其他行 → 本行加其后缩进的续行。 */
function blockAt(lines: readonly string[], at: number): string {
  const head = lines[at]!;
  const rest = lines.slice(at + 1);
  const end = isHeading(head) ? rest.findIndex(isHeading) : rest.findIndex(notIndented);
  return [head, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

function expectRecording(lines: readonly string[], title: string): void {
  const starts = lines.flatMap((line, at) => (startsWithLabel(line, '录制') ? [at] : []));
  const blocks = starts.map((at) => blockAt(lines, at));
  expect(blocks.length, `「${title}」节须有「录制」一行或小节`).toBeGreaterThan(0);
  const paths = blocks.flatMap(backticked).filter((token) => token.includes('/'));
  expect(paths.length, `「${title}」节录制须引私有路径`).toBeGreaterThan(0);
  for (const path of paths) {
    expect(path, `录制引用 ${path} 须在 cap-tests 下`).toMatch(RECORDING_PATH);
  }
  for (const block of blocks) {
    expect(block, '录制只引私有路径，不放链接').not.toMatch(/https?:\/\//);
  }
}

function expectReviewStatus(lines: readonly string[], title: string): void {
  const at = lines.findIndex((line) => line.includes('核对状态'));
  expect(at, `「${title}」节须有「核对状态」`).toBeGreaterThanOrEqual(0);
  const line = lines[at]!;
  const tail = line.slice(line.indexOf('核对状态') + 4).replace(/[\s*:：|]/g, '');
  const block = isHeading(line) ? blockAt(lines, at) : '';
  const body = block.split('\n').slice(1).join('').trim();
  expect(tail + body, `「${title}」节「核对状态」后须写明状态`).not.toBe('');
}

function platformCase(platform: string): PlatformCase {
  const found = PLATFORMS.find((c) => c.platform === platform);
  if (found === undefined) throw new Error(`unknown platform ${platform}`);
  return found;
}

function expectRepoPaths(paths: readonly string[]): void {
  for (const path of paths) {
    const relative = !path.startsWith('/') && !path.split('/').includes('..');
    expect(relative, `${path} 须是仓库相对路径`).toBe(true);
    expect(existsSync(new URL(path, ROOT)), `${path} 须存在`).toBe(true);
  }
}

/** subsidy_commission_fen 行没有报文字段时，须写明不输出的口径。 */
const SUBSIDY_ABSENT = /未输出|恒为\s*`?null`?|不读/;
/** 京东 actualFee 与 estimateFee 之间不得有的加减写法。 */
const JD_ARITHMETIC = /[−+＋-]|减|加|扣/;
/** 子句：不跨 。；; */
const CLAUSE_BREAK = /[。；;]/;
/** 短语：子句再按逗号、顿号、斜杠、括号细分，用于判错配。 */
const PHRASE_BREAK = /[。；;，,、/／（）()]/;
/** 京东 validCode 限定词：「非 17」先吃掉其中的 17；单独的 17 是已完成。 */
const QUALIFIER = /非[^，,、。；;\d]{0,12}?17(?!\d)|(?<![\d.])17(?!\d)|其余|其他|未完成/g;

// finished：17；rest：其余 / 其他 / 非 17；unfinished：未完成。
type Validity = 'finished' | 'rest' | 'unfinished';

interface Mark {
  readonly kind: Validity;
  readonly index: number;
}

function qualifierMarks(text: string): Mark[] {
  return [...text.matchAll(QUALIFIER)].map((m): Mark => ({
    kind: m[0] === '17' ? 'finished' : m[0] === '未完成' ? 'unfinished' : 'rest',
    index: m.index ?? 0,
  }));
}

function termIndexes(text: string, term: string): number[] {
  const re = new RegExp(`(?<!\\w)${term}(?!\\w)`, 'g');
  return [...text.matchAll(re)].map((m) => m.index ?? 0);
}

/** 京东 est 行公式列与取值时机列，按 splitter 切开。 */
function jdPieces(row: Row, splitter: RegExp): string[] {
  return [row.formula, row.timing].flatMap((cell) => cell.split(splitter));
}

/** 有一个子句里 kind 限定词出现在 term 之前。 */
function qualifiedBefore(clauses: readonly string[], term: string, kind: Validity): boolean {
  return clauses.some((clause) => {
    const first = qualifierMarks(clause).find((mark) => mark.kind === kind);
    return first !== undefined && termIndexes(clause, term).some((at) => at > first.index);
  });
}

/** term 前最近的限定词不在 allowed 里的短语（把字段配给了错的状态）。 */
function mismatched(
  phrases: readonly string[],
  term: string,
  allowed: readonly Validity[],
): string[] {
  return phrases.filter((phrase) => {
    const marks = qualifierMarks(phrase);
    return termIndexes(phrase, term).some((at) => {
      const nearest = marks.filter((mark) => mark.index < at).pop();
      return nearest !== undefined && !allowed.includes(nearest.kind);
    });
  });
}

/** a、b 两个词相邻出现（中间没有另一次出现）时，两者之间的文字。 */
function termGaps(text: string, a: string, b: string): string[] {
  const hits = [
    ...termIndexes(text, a).map((index) => ({ term: a, index })),
    ...termIndexes(text, b).map((index) => ({ term: b, index })),
  ].sort((x, y) => x.index - y.index);
  const gaps: string[] = [];
  for (let i = 1; i < hits.length; i += 1) {
    const prev = hits[i - 1]!;
    const next = hits[i]!;
    if (prev.term !== next.term) gaps.push(text.slice(prev.index + prev.term.length, next.index));
  }
  return gaps;
}

/** 京东行里与「服务费」同子句时不得出现的扣减标记。 */
const JD_FEE_DEDUCTION = /[−-]|减|扣/;

/** 京东一行各列按子句切开；同一单元格无标点时整格算一个子句。 */
function rowClauses(row: Row): string[] {
  return [row.dto, row.formula, row.timing, row.location].flatMap((cell) =>
    cell.split(CLAUSE_BREAK),
  );
}

function isPlainPath(token: string): boolean {
  return token.includes('/') && token.split('/').every((part) => PATH_PART.test(part));
}

/** 长度 ≥ 20、含大写 / 小写 / 数字中至少两类、又不是整段文件路径的串。 */
function isSecretLike(token: string): boolean {
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((re) => re.test(token)).length;
  return classes >= 2 && !isPlainPath(token);
}

it('[AC-B1-18b#1] 文档存在并引用 BR-CALC-03 与 BR-CALC-18', () => {
  const doc = loadDoc();
  expect(doc).toContain('BR-CALC-03');
  expect(doc).toContain('BR-CALC-18');
});

it.each(PLATFORMS)('[AC-B1-18b#1] $title 一节有 N 取数表', (c) => {
  const rows = tableOf(c);
  expect(rows.length, `「${c.title}」节 N 取数表须有数据行`).toBeGreaterThan(0);
});

it.each(PLATFORMS)('[AC-B1-18b#2] $title 的表有 est / settle 两行', (c) => {
  const rows = tableOf(c);
  rowOf(rows, 'est_commission_fen', c.title);
  rowOf(rows, 'settle_commission_fen', c.title);
});

it.each(PLATFORMS)('[AC-B1-18b#3] $title 的报文字段都在 $source 里有映射', (c) => {
  const fields = wireFields(tableOf(c));
  expect(fields.length, `「${c.title}」节须用反引号写报文字段名`).toBeGreaterThan(0);
  const names = sourceNames(c.source);
  for (const field of fields) {
    for (const segment of field.split('.')) {
      expect(names.has(segment), `${c.source} 须有 ${segment}（${field}）`).toBe(true);
    }
  }
});

it.each(PLATFORMS)('[AC-B1-18b#4] $title 的实现位置路径都存在', (c) => {
  const paths = locationPaths(tableOf(c));
  expect(paths.length, `「${c.title}」节实现位置须写仓库相对路径`).toBeGreaterThan(0);
  for (const path of paths) {
    const relative = !path.startsWith('/') && !path.split('/').includes('..');
    expect(relative, `${path} 须是仓库相对路径`).toBe(true);
    expect(existsSync(new URL(path, ROOT)), `${path} 须存在`).toBe(true);
  }
});

it.each(PLATFORMS)('[AC-B1-18b#5] $title 的 N 公式与源码口径一致', (c) => {
  const rows = tableOf(c);
  const est = rowOf(rows, 'est_commission_fen', c.title);
  const settle = rowOf(rows, 'settle_commission_fen', c.title);
  expectFormula(est, c.est, 'est_commission_fen', c.title);
  expectFormula(settle, c.settle, 'settle_commission_fen', c.title);
});

it.each(PLATFORMS)('[AC-B1-18b#5] $title 一节没有佣金加服务费的写法', (c) => {
  const lines = sectionOf(loadDoc(), c.title).split('\n');
  expect(tableOf(c).length).toBeGreaterThan(0);
  for (const line of lines) {
    for (const pattern of FEE_ADDITION) {
      expect(line, `「${c.title}」节不得把服务费加回佣金`).not.toMatch(pattern);
    }
  }
});

it.each(PLATFORMS)('[AC-B1-18b#6] $title 一节有录制引用与核对状态', (c) => {
  const lines = sectionOf(loadDoc(), c.title).split('\n');
  expectRecording(lines, c.title);
  expectReviewStatus(lines, c.title);
});

it('[AC-B1-18b#7] 文档不泄密', () => {
  const doc = loadDoc();
  expect(doc, '不得出现淘宝 PID').not.toMatch(/mm_\d+_\d+_\d+/);
  expect(doc, '不得出现数字下划线数字形式的 PID').not.toMatch(/\b\d+(?:_\d+)+\b/);
  expect(doc, '不得出现长度 ≥ 20 的十六进制串').not.toMatch(HEX_20);
  for (const m of doc.matchAll(BASE64_20)) {
    expect(isSecretLike(m[0]), `疑似密钥样串：${m[0].slice(0, 6)}…`).toBe(false);
  }
  expect(doc, '不得写 app_secret / client_secret 取值').not.toMatch(SECRET_VALUE);
  expect(doc, '不得有 json 代码块').not.toMatch(/```\s*json/i);
});

it.each(PLATFORMS)('[AC-B1-18b#8] $title 的表有 subsidy_commission_fen 行', (c) => {
  const row = rowOf(tableOf(c), 'subsidy_commission_fen', c.title);
  const label = `「${c.title}」节 \`subsidy_commission_fen\` 行`;
  const paths = locationPaths([row]);
  expect(paths.length, `${label}实现位置须写仓库相对路径`).toBeGreaterThan(0);
  expectRepoPaths(paths);
  const absent = SUBSIDY_ABSENT.test(`${row.formula}\n${row.timing}`);
  const explained = wireFields([row]).length > 0 || absent;
  expect(explained, `${label}没有报文字段时须写「未输出」「恒为 null」或「不读」`).toBe(true);
});

it.each(PLATFORMS)('[AC-B1-18b#9] $title 一节写明基础 N 不含补贴类佣金的依据', (c) => {
  const section = sectionOf(loadDoc(), c.title);
  expect(section, `「${c.title}」节须写补贴口径`).toContain('补贴');
  expect(section, `「${c.title}」节须引 BR-CALC-18`).toContain('BR-CALC-18');
});

it('[AC-B1-18b#10] 京东 est_commission_fen 行 actualFee 与 estimateFee 之间没有加减', () => {
  const row = rowOf(tableOf(platformCase('jd')), 'est_commission_fen', '京东');
  expect(wordAt(row.line, 'actualFee'), '京东 est 行须出现 actualFee').not.toBeNull();
  expect(wordAt(row.line, 'estimateFee'), '京东 est 行须出现 estimateFee').not.toBeNull();
  // 加减式不跨格、不跨子句；格内每个子句里两字段相邻处都查。
  const gaps = jdPieces(row, CLAUSE_BREAK).flatMap((clause) =>
    termGaps(clause, 'actualFee', 'estimateFee'),
  );
  for (const gap of gaps) {
    expect(gap, '京东报文已是净额：actualFee 与 estimateFee 之间不得写加减或扣').not.toMatch(
      JD_ARITHMETIC,
    );
  }
});

it('[AC-B1-18b#11] 京东 est_commission_fen 行写明 17 取 actualFee、其余取 estimateFee', () => {
  const row = rowOf(tableOf(platformCase('jd')), 'est_commission_fen', '京东');
  const clauses = jdPieces(row, CLAUSE_BREAK);
  expect(
    qualifiedBefore(clauses, 'actualFee', 'finished'),
    '京东 est 行须在同一子句内写「17 取 actualFee」',
  ).toBe(true);
  expect(
    qualifiedBefore(clauses, 'estimateFee', 'rest'),
    '京东 est 行须在同一子句内写「其余 / 其他 / 非 17 取 estimateFee」',
  ).toBe(true);
  const phrases = jdPieces(row, PHRASE_BREAK);
  expect(mismatched(phrases, 'actualFee', ['finished']), 'actualFee 只配给 17').toEqual([]);
  expect(
    mismatched(phrases, 'estimateFee', ['rest', 'unfinished']),
    'estimateFee 不得配给 17',
  ).toEqual([]);
});

it.each(PLATFORMS)('[AC-B1-18b#12] $title 的表每行都写取值时机', (c) => {
  const rows = tableOf(c);
  expect(rows.length, `「${c.title}」节 N 取数表须有数据行`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.timing.trim(), `「${c.title}」节 ${row.dto} 行取值时机不得为空`).not.toBe('');
  }
});

it('[AC-B1-18b#13] 淘宝 settle_commission_fen 行取值时机写 tk_status 与 3', () => {
  const row = rowOf(tableOf(platformCase('taobao')), 'settle_commission_fen', '淘宝');
  expect(wordAt(row.timing, 'tk_status'), '淘宝 settle 行取值时机须写 tk_status').not.toBeNull();
  expect(row.timing, '淘宝 settle 行取值时机须写 3').toMatch(/(?<!\d)3(?!\d)/);
});

it('[AC-B1-18b#14] 京东 est / settle 行没有扣服务费的写法', () => {
  const rows = tableOf(platformCase('jd'));
  for (const field of ['est_commission_fen', 'settle_commission_fen']) {
    const row = rowOf(rows, field, '京东');
    for (const clause of rowClauses(row)) {
      if (!clause.includes('服务费')) continue;
      expect(
        clause,
        `京东报文已是净额：\`${field}\` 行「服务费」不得与扣减同在一个子句`,
      ).not.toMatch(JD_FEE_DEDUCTION);
    }
  }
});
