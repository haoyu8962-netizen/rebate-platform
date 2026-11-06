// B2-04zx（FU-B104ZZA-AUDIT-PORT，编排 D10-723）②：审计只经端口写，settlement 不越模块写 admin 的审计表
// （apps/api AGENTS.md 硬规则 1「单一写者」、settlement AGENTS.md 硬规则 7）。源码文本检查：
//   - settlement/rights/**（不含 *.test.ts）去掉注释后不出现 audit_logs 表名（注释里可以出现，例如解释为什么
//     不写）；
//   - 整个 settlement 模块（不含 *.test.ts）去掉注释后没有对 audit_logs 的写入语句（insert into / insertInto /
//     update / updateTable / delete from / deleteFrom 后跟 audit_logs，带不带 app. 前缀都算）。
// 去注释的做法同 test/spec/settlement/run-done/source.test.ts：`//` 到行尾、`/* … */`，只会多藏文本、不会多出文本。
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const MODULE = new URL('../../../../apps/api/src/modules/settlement/', import.meta.url);
const RIGHTS = new URL('rights/', MODULE);

interface Source {
  readonly path: string;
  readonly code: string;
}

/** The source without its comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every non-test .ts file under `dir`, by its path below `prefix`. */
function sources(dir: URL, prefix: string): Source[] {
  return readdirSync(dir, { encoding: 'utf8', recursive: true })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => ({
      path: `${prefix}${name}`,
      code: withoutComments(readFileSync(new URL(name, dir), 'utf8')),
    }));
}

const AUDIT_WRITE =
  /(insert\s+into|update|delete\s+from)\s+("?app"?\s*\.\s*)?"?audit_logs\b|(insertInto|updateTable|deleteFrom)\s*\(\s*['"`](app\.)?audit_logs['"`]/i;

it('[AC-B2-04zx#7] settlement/rights/** 源码（不含 *.test.ts）去掉注释后不出现 audit_logs；整个 settlement 模块源码去掉注释后没有对 audit_logs 的写入语句（审计只经注入的端口）', () => {
  const rights = sources(RIGHTS, 'rights/');
  expect(rights.map((s) => s.path)).toContain('rights/rights-command.ts');
  expect(rights.map((s) => s.path)).toContain('rights/rights-store.ts');
  expect(rights.filter((s) => /audit_logs/.test(s.code)).map((s) => s.path)).toEqual([]);

  const all = sources(MODULE, '');
  expect(all.length).toBeGreaterThan(rights.length);
  expect(all.filter((s) => AUDIT_WRITE.test(s.code)).map((s) => s.path)).toEqual([]);
});
