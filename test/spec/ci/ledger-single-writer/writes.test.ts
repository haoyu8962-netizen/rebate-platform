import { it } from 'vitest';
import { listTreeFiles } from '../../../../tools/guard/lib/tree.ts';
import {
  BALANCES,
  BALANCE_UPDATE,
  ENTRIES,
  VOUCHERS,
  check,
  expectPass,
  expectWrite,
  fixture,
} from './ledger-writer-fixture.ts';

const TS_FILE = 'apps/api/src/modules/orders/fixture.ts';
const SQL_FILE = 'db/migrations/9999_fixture.sql';

it.each([
  ['insertInto', ENTRIES, ENTRIES, ''],
  ['updateTable', `app.${BALANCES} as balance`, BALANCES, ''],
  ['deleteFrom', `"APP"."LEDGER_VOUCHERS" as voucher`, VOUCHERS, ''],
  ['mergeInto', `APP.${ENTRIES.toUpperCase()}`, ENTRIES, '\n  '],
  ['replaceInto', VOUCHERS, VOUCHERS, ''],
] as const)('[CT-06zzzzzx#1] 拦截 Kysely %s 的表名参数', (method, reference, table, spacing) => {
  // Assemble the source inside .tmp so these examples are not writes in the checked-in test.
  const root = fixture({ [TS_FILE]: `// 夹具\n\ndb.${method}(${spacing}'${reference}');\n` });
  expectWrite(check(root), TS_FILE, spacing === '' ? [3] : [3, 4], table, new RegExp(method, 'i'));
});

it.each([
  ['INSERT', ['iNsErT', 'iNtO', `"app"."${ENTRIES}" VALUES (1);`].join('\n'), ENTRIES, [3, 4, 5]],
  [
    'UPDATE',
    ['UpDaTe', `"${BALANCES.toUpperCase()}" AS b SET version = 1;`].join(' '),
    BALANCES,
    [3],
  ],
  ['DELETE', ['dElEtE FROM', `app.${VOUCHERS} AS v WHERE false;`].join(' '), VOUCHERS, [3]],
  [
    'MERGE',
    [
      'mErGe',
      `INTO app.${BALANCES} AS b`,
      'USING staging AS s ON false WHEN MATCHED THEN DO NOTHING;',
    ].join('\n'),
    BALANCES,
    [3, 4],
  ],
  ['TRUNCATE', ['tRuNcAtE', `app.${ENTRIES};`].join(' '), ENTRIES, [3]],
  [
    'COPY',
    ['cOpY', `"APP"."${VOUCHERS.toUpperCase()}" (app_id)`, 'FROM STDIN;'].join('\n'),
    VOUCHERS,
    [3, 4, 5],
  ],
] as const)('[CT-06zzzzzx#2] 拦截 SQL 文件里的 %s', (operation, statement, table, lines) => {
  const root = fixture({ [SQL_FILE]: `-- 夹具\n\n${statement}\n` });
  expectWrite(check(root), SQL_FILE, lines, table, new RegExp(`\\b${operation}\\b`, 'i'));
});

it('[CT-06zzzzzx#3] TRUNCATE TABLE 的逗号列表会报出排在其他表后面的每张账务表', () => {
  const statement = [
    'TRUNCATE TABLE',
    `app.unrelated, app.${ENTRIES},\n  "app"."${BALANCES}";`,
  ].join(' ');
  const root = fixture({ [SQL_FILE]: `-- 夹具\n\n${statement}\n` });
  const result = check(root);
  expectWrite(result, SQL_FILE, [3], ENTRIES, /\btruncate\b/i);
  expectWrite(result, SQL_FILE, [3, 4], BALANCES, /\btruncate\b/i);
});

it('[CT-06zzzzzx#4] 拦截 TS 字符串、普通模板和 sql 标签模板里的 SQL', () => {
  const plain = 'apps/api/src/modules/orders/plain.ts';
  const template = 'apps/api/src/modules/orders/template.ts';
  const tagged = 'apps/api/src/modules/orders/tagged.ts';
  const insert = ['INSERT INTO', `app.${ENTRIES} VALUES (1);`].join(' ');
  const remove = ['DELETE FROM', `"app"."${VOUCHERS}" WHERE false;`].join('\n');
  const root = fixture({
    [plain]: `// 夹具\n\nconst query = ${JSON.stringify(insert)};\n`,
    [template]: `// 夹具\n\nconst query = \`${BALANCE_UPDATE}\`;\n`,
    [tagged]: `// 夹具\n\nconst query = sql\`${remove}\`;\n`,
  });
  const result = check(root);
  expectWrite(result, plain, [3], ENTRIES, /\binsert\b/i);
  expectWrite(result, template, [3], BALANCES, /\bupdate\b/i);
  expectWrite(result, tagged, [3, 4], VOUCHERS, /\bdelete\b/i);
});

it('[CT-06zzzzzx#5] 触发器、授权、DDL、读、读加锁和注释均不算写入', () => {
  const call = `db.selectFrom('app.${BALANCES} as b').forUpdate();`;
  const lock = ['SELECT * FROM', `app.${BALANCES} FOR UPDATE;`].join(' ');
  const read = `SELECT v.id FROM app.${VOUCHERS} v JOIN app.${ENTRIES} e ON e.voucher_id = v.id;`;
  const copyTo = ['COPY', `app.${ENTRIES} TO STDOUT;`].join(' ');
  const root = fixture({
    [TS_FILE]: [
      call,
      `const locked = sql\`${lock}\`;`,
      `// Lock the ${BALANCES} row FOR UPDATE`,
      `// ${BALANCE_UPDATE}`,
      `/* ${BALANCE_UPDATE} */`,
    ].join('\n'),
    [SQL_FILE]: [
      `CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON app.${VOUCHERS} FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();`,
      `GRANT SELECT, INSERT ON app.${ENTRIES} TO couli_app;`,
      `CREATE TABLE app.${ENTRIES} (id bigint) PARTITION BY RANGE (id);`,
      `CREATE TABLE app.entries_default PARTITION OF app.${ENTRIES} DEFAULT;`,
      lock,
      read,
      copyTo,
      `UPDATE app.unrelated SET version = 1 FROM app.${BALANCES};`,
      `-- ${BALANCE_UPDATE}`,
      `/* ${BALANCE_UPDATE} */`,
    ].join('\n'),
  });
  expectPass(check(root));
});

it('[CT-06zzzzzx#6] 忽略生成物、依赖、未列入扫描清单的文件与其他扩展名', () => {
  const unlisted = 'apps/api/src/modules/orders/unlisted.ts';
  const query = `const statement = ${JSON.stringify(BALANCE_UPDATE)};\n`;
  const root = fixture({
    'packages/db/src/db.gen.ts': query,
    'db/schema.sql': BALANCE_UPDATE,
    'node_modules/dependency/index.ts': query,
    'tools/example.txt': BALANCE_UPDATE,
    [unlisted]: query,
  });
  const tree = listTreeFiles(root);
  expectPass(check(root, { ...tree, files: tree.files.filter((file) => file !== unlisted) }));
});
