// D10-1902 / D10-1916: P3 follows type context through nesting; P2 still applies to values.
// Every top-level test includes a tuple regression, so the old classifier must fail each test.
// Existing support-allowlist / modify-existing-support tests and production code stay frozen.
import { afterAll, it } from 'vitest';
import { SLOW, cleanup, deepShape, inlineTupleCases, typeCases } from './kit.ts';

afterAll(cleanup);

it(
  '[AC-CT-06zzzzzk#1] type aliases: nested optional members pass; required members are refused at their file and inserted line',
  () => {
    typeCases('alias', (type, i) => `type Row${i} = ${type};`);
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#2] interface members: nested optional members pass; required members are refused at their file and inserted line',
  () => {
    typeCases('interface', (type, i) => `interface Row${i} { value: ${type}; }`);
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#3] variable annotations use P3 through nesting while object values in arrays still allow appended P2 properties',
  () => {
    typeCases('variable', (type, i) => `const row${i}: ${type} = raw;`, undefined, undefined, [
      'const rows = [{ a: 1 }];',
      'const later = [0, { a: 1 }];',
      'const typed: unknown = [{ a: 1 }];',
      'const nestedValues = [{ x: [{ a: 1 }] }];',
    ]);
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#4] parameter annotations use P3 through nesting while array arguments still allow appended P2 properties',
  () => {
    typeCases(
      'parameter',
      (type, i) => `function take${i}(value: ${type}) { void value; }`,
      undefined,
      undefined,
      ['f([{ a: 1 }]);', 'f([0, { a: 1 }]);', 'f([{ x: [{ a: 1 }] }]);'],
    );
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#5] return annotations: nested optional members pass; required members are refused at their file and inserted line',
  () => {
    typeCases('return', (type, i) => `function make${i}(): ${type} { return raw; }`);
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#6] as types use P3 through nesting while the asserted array value still allows appended P2 properties',
  () => {
    typeCases('as', (type, i) => `const row${i} = raw as ${type};`, undefined, undefined, [
      'const values = [{ a: 1 }] as unknown;',
    ]);
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#7] satisfies types use P3 through nesting while the checked array value still allows appended P2 properties',
  () => {
    typeCases(
      'satisfies',
      (type, i) => `const row${i} = raw satisfies ${type};`,
      undefined,
      undefined,
      ['const values = [{ a: 1 }] satisfies unknown;'],
    );
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#8] repeated mixed nesting preserves P3 with comma, semicolon, trailing separators and newline-only member separation',
  () => {
    typeCases(
      'deep',
      (type, i) => `type Row${i} = ${type};`,
      [deepShape(2), deepShape(5), deepShape(12)],
      [
        [',', ''],
        [';', ''],
        [',', ','],
        [';', ';'],
        ['', ''],
      ],
    );
  },
  2 * SLOW,
);

it(
  '[AC-CT-06zzzzzk#9] the single-line tuple reproduction rejects required members with either separator and allows their optional counterparts',
  () => {
    inlineTupleCases();
  },
  SLOW,
);
