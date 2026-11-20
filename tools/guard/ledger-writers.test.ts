import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import { writeFiles } from './lib/fixture-kit.ts';
import {
  LEDGER_WRITERS_ALLOWLIST,
  blankSqlComments,
  blankTsComments,
  findLedgerWrites,
  isScanned,
  ledgerWritersCheck,
  parseLedgerAllowlist,
  trackedFiles,
} from './ledger-writers.ts';
import { listTreeFiles } from './lib/tree.ts';

// Statements are assembled at run time so this file itself holds no ledger write.
const BALANCES = ['account', 'balances'].join('_');
const ENTRIES = ['ledger', 'entries'].join('_');
const update = (table: string): string => ['UPDATE', table, 'SET version = 1'].join(' ');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const parent = join(repoRoot(), '.tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'ledger-writers-unit-'));
  roots.push(root);
  writeFiles(root, files);
  return root;
}

it('blanks comments but keeps offsets, line breaks, strings and templates', () => {
  const source = `const a = '// not a comment'; // gone\n/* gone\n */ const b = \`x\${'y'}\`;`;
  const blanked = blankTsComments(source);
  expect(blanked).toHaveLength(source.length);
  expect(blanked).toContain("'// not a comment'");
  expect(blanked).not.toContain('gone');
  expect(blanked.split('\n')).toHaveLength(3);
  expect(blanked).toContain("`x${'y'}`");
  expect(blankSqlComments(`SELECT '--x' -- gone\n/* gone */ 1;`)).not.toContain('gone');
});

it('a regular expression literal with a quote or slashes does not start a string or comment', () => {
  const source = `const re = /["'\\/]+/g; ${JSON.stringify(update(BALANCES))};`;
  expect(findLedgerWrites('a.ts', source)).toEqual([
    { line: 1, table: BALANCES, operation: 'UPDATE' },
  ]);
});

it('an escaped line break before the keyword still counts, and FOR UPDATE does not', () => {
  const text =
    `const s = '-- note\\n${update(`app.${BALANCES}`)}';\n` +
    `const r = 'SELECT 1 FROM app.${ENTRIES} FOR UPDATE';\n`;
  expect(findLedgerWrites('a.ts', text)).toEqual([
    { line: 1, table: BALANCES, operation: 'UPDATE' },
  ]);
});

it('a table whose name only starts with a ledger table name is not a hit', () => {
  expect(findLedgerWrites('a.sql', update(`app.${ENTRIES}_default`))).toEqual([]);
  expect(findLedgerWrites('a.sql', update(`other_${ENTRIES}`))).toEqual([]);
});

it('only .ts and .sql sources outside dependencies and generated files are scanned', () => {
  expect(isScanned('apps/api/src/x.ts')).toBe(true);
  expect(isScanned('db/seeds/x.sql')).toBe(true);
  expect(isScanned('db/schema.sql')).toBe(false);
  expect(isScanned('packages/db/src/db.gen.ts')).toBe(false);
  expect(isScanned('packages/x/node_modules/y/index.ts')).toBe(false);
  expect(isScanned('apps/h5/src/x.tsx')).toBe(false);
});

it('allowlist rows need a Tab and a reason and a relative path without wildcards', () => {
  const { entries, problems } = parseLedgerAllowlist(
    ['# c', '', 'a.ts\treason', 'b.ts', 'c.ts\t ', 'd/*.ts\tr', '../e.ts\tr', '/f.ts\tr'].join(
      '\n',
    ),
  );
  expect(entries).toEqual([{ path: 'a.ts', reason: 'reason', line: 3 }]);
  expect(problems).toHaveLength(5);
});

it('a directory entry needs a trailing slash and a file entry must not have one', () => {
  const root = tree({
    [LEDGER_WRITERS_ALLOWLIST]: 'test/spec/x\tdir\napps/a.ts/\tfile\n',
    'test/spec/x/a.ts': '',
    'apps/a.ts': '',
  });
  const result = ledgerWritersCheck(root, {
    files: ['apps/a.ts', 'test/spec/x/a.ts'],
    mode: 'walk',
  });
  expect(result.status).toBe('fail');
  expect(result.problems).toHaveLength(2);
});

it('every write of an unlisted file is reported with its line', () => {
  const root = tree({
    'apps/a.ts': `\nconst q = ${JSON.stringify(update(BALANCES))};\ndb.deleteFrom('${ENTRIES}');\n`,
  });
  const result = ledgerWritersCheck(root, { files: ['apps/a.ts'], mode: 'walk' });
  expect(result.problems.map((p) => p.split('，')[0])).toEqual([
    'apps/a.ts:2: 直接写账务表',
    'apps/a.ts:3: 直接写账务表',
  ]);
  expect(result.notices).toHaveLength(1);
});

it('an SQL comment inside a TypeScript template or string is no write (review r1 S1)', () => {
  const text =
    'const q = sql`\n' +
    `  -- ${update(`app.${BALANCES}`)} only through the ledger module\n` +
    `  /* DELETE FROM app.${ENTRIES} */ SELECT * FROM app.${BALANCES}\n` +
    '`;\n' +
    `const s = '-- ${update(BALANCES)}';\n`;
  expect(findLedgerWrites('a.ts', text)).toEqual([]);
  expect(blankTsComments(text)).toHaveLength(text.length);
});

it('a comment between the keyword and the table does not hide a write (review r1 S1)', () => {
  const tpl =
    'const q = sql`\n' +
    `  UPDATE /* repair */ app.${BALANCES} SET version = version + 1;\n` +
    `  DELETE -- why\n  FROM app . /* x */ ${ENTRIES} WHERE id = \${id};\n` +
    '`;\n';
  expect(findLedgerWrites('a.ts', tpl)).toEqual([
    { line: 2, table: BALANCES, operation: 'UPDATE' },
    { line: 4, table: ENTRIES, operation: 'DELETE FROM' },
  ]);
  const str = `const s = 'INSERT /* a */ INTO -- b\\n app.${BALANCES} (id) VALUES (1)';\n`;
  expect(findLedgerWrites('a.ts', str)).toEqual([
    { line: 1, table: BALANCES, operation: 'INSERT INTO' },
  ]);
  const file = `UPDATE /* repair */ app.${BALANCES} SET version = 1;\n-- ${update(ENTRIES)}\n`;
  expect(findLedgerWrites('a.sql', file)).toEqual([
    { line: 1, table: BALANCES, operation: 'UPDATE' },
  ]);
});

it('a quoted SQL text keeps its dashes and a nested block comment is blanked whole', () => {
  const file =
    `SELECT '-- x' AS a; ${update(BALANCES)};\n` + `/* a /* b */ ${update(ENTRIES)} */ SELECT 1;\n`;
  expect(findLedgerWrites('a.sql', file)).toEqual([
    { line: 1, table: BALANCES, operation: 'UPDATE' },
  ]);
  // `--` inside an SQL literal is text, not a comment: dynamic SQL (`EXECUTE '…'`) still counts.
  const ts = `const t = "EXECUTE '-- x\\n${update(BALANCES)}'";\n`;
  expect(findLedgerWrites('a.ts', ts)).toEqual([{ line: 1, table: BALANCES, operation: 'UPDATE' }]);
  const quoted = `const t = "SELECT '-- ${update(BALANCES)}' AS note";\n`;
  expect(findLedgerWrites('a.ts', quoted)).toHaveLength(1);
});

it('TRUNCATE across lines, with comments, and every ledger table of its list (review r1 S1)', () => {
  const file =
    `TRUNCATE TABLE app.\n  ${BALANCES};\n` +
    `TRUNCATE ONLY app /* s */ . "${ENTRIES}" *,\n  other.x,\n  app.\n  ${BALANCES} CASCADE;\n` +
    `TRUNCATE other.${ENTRIES}, other . ${BALANCES};\n`;
  expect(findLedgerWrites('a.sql', file)).toEqual([
    { line: 2, table: BALANCES, operation: 'TRUNCATE' },
    { line: 3, table: ENTRIES, operation: 'TRUNCATE' },
    { line: 6, table: BALANCES, operation: 'TRUNCATE' },
  ]);
  const ts = `const s = \`TRUNCATE TABLE app.\n${BALANCES}\`;\n`;
  expect(findLedgerWrites('a.ts', ts)).toEqual([
    { line: 2, table: BALANCES, operation: 'TRUNCATE' },
  ]);
});

it('whitespace around the schema dot counts for the other writes and Kysely calls', () => {
  const text =
    `db.insertInto('app . ${BALANCES}');\n` +
    `const s = \`MERGE INTO app\n.${ENTRIES} USING x ON true\`;\n` +
    `db.updateTable('other . ${BALANCES}');\n`;
  expect(findLedgerWrites('a.ts', text)).toEqual([
    { line: 1, table: BALANCES, operation: 'insertInto' },
    { line: 3, table: ENTRIES, operation: 'MERGE INTO' },
  ]);
});

it('with git only tracked files are checked; an untracked draft does not fail (review r1 S2)', () => {
  const root = tree({
    'db/seeds/tracked.sql': 'SELECT 1;\n',
    'db/seeds/local-repair.sql': `${update(`app.${BALANCES}`)};\n`,
  });
  const run = (...args: string[]): void => {
    const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
  };
  run('init', '-q');
  run('add', 'db/seeds/tracked.sql');
  const listing = listTreeFiles(root);
  expect(listing.files).toContain('db/seeds/local-repair.sql');
  expect(trackedFiles(root, listing).files).toEqual(['db/seeds/tracked.sql']);
  expect(ledgerWritersCheck(root, trackedFiles(root, listing)).status).toBe('pass');
  expect(ledgerWritersCheck(root, listing).status).toBe('fail');
  // Without .git the walked tree is kept as it is.
  const walked = { files: ['db/seeds/local-repair.sql'], mode: 'walk' as const };
  expect(trackedFiles(root, walked)).toBe(walked);
});
