// D10-1924 / D10-1929 / D10-1932: required type members must never inherit P2 value rules.
// Each top-level test pairs a regression with optional-member / existing-? positive controls.
import { afterAll, it } from 'vitest';
import { SLOW, cleanup, operandCases, positionCases } from './kit.ts';

afterAll(cleanup);

it(
  '[AC-CT-06zzzzzn#1] a zero-parameter function check preserves P3 in the inline conditional tuple reproduction',
  () => {
    positionCases(
      'conditional-inline',
      ['type Row<T> = T extends () => void ? [{ a: number }] : never;'],
      ['const t = cond ? [{ a: 1 }] : [];'],
      true,
    );
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#2] a function check with parameters preserves P3 in the true object and tuple branches and reports the inserted line',
  () => {
    positionCases('conditional-true', [
      'type Row<T> = T extends (x: A) => B ? { a: number } : { other: boolean };',
      'type Tuple<T> = T extends (x: A, y: string) => B ? [{ a: number }] : never;',
    ]);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#3] a function check preserves P3 in the false object and tuple branches while false conditional values retain P2',
  () => {
    positionCases(
      'conditional-false',
      [
        'type Row<T> = T extends (x: A) => B ? { other: boolean } : { a: number };',
        'type Tuple<T> = T extends () => void ? never : [{ a: number }];',
      ],
      [
        'const t = cond ? [] : [{ a: 1 }];',
        'const h = <T extends A>(x: T) => cond ? [{ a: 1 }] : [];',
      ],
    );
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#4] type alias parameter defaults use P3 for direct and nested object types',
  () => {
    positionCases('default-alias', [
      'type Box<T = { a: number }> = T;',
      'type Tuple<U, T = [{ a: number }]> = T;',
    ]);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#5] interface parameter defaults use P3 for direct and nested object types',
  () => {
    positionCases('default-interface', [
      'interface I<T = { a: number }> { value: T; }',
      'interface J<U, T = [{ a: number }]> { value: T; }',
    ]);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#6] function type parameter defaults use P3 while runtime parameter default objects retain P2',
  () => {
    positionCases(
      'default-function',
      ['function f<T = { a: number }>() {}', 'function g<U, T = [{ a: number }]>() {}'],
      ['function withDefault(x = { a: 1 }) { void x; }'],
    );
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#7] class parameter defaults use P3 for direct and nested object types',
  () => {
    positionCases('default-class', [
      'class Box<T = { a: number }> {}',
      'class Tuple<U, T = [{ a: number }]> {}',
    ]);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#8] arrow type parameter defaults use P3 while arrow runtime parameter default objects retain P2',
  () => {
    positionCases(
      'default-arrow',
      ['const f = <T = { a: number }>() => raw;', 'const g = <U, T = [{ a: number }]>() => raw;'],
      ['const withDefault = (x = { a: 1 }) => x;'],
    );
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#9] async as an operand admits as and satisfies types under P3; async function values retain P2',
  () => {
    operandCases('async', 'async function load() { return { a: 1 }; }');
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#10] of as an operand admits as and satisfies types under P3; for-of body values retain P2',
  () => {
    operandCases('of', 'for (const x of items) { const value = { a: 1 }; }');
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#11] from and get operands use P3 for as and satisfies; import and getter controls retain P2',
  () => {
    operandCases('from', "import x from './source.ts'; const value = { a: 1 };");
    operandCases('get', 'class Getter { get value() { return { a: 1 }; } }');
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#12] type and set operands use P3 for as and satisfies; type alias and setter controls retain P2',
  () => {
    operandCases('type', 'type T = typeof value; const value = { a: 1 };');
    operandCases('set', 'class Setter { set value(x: unknown) { const value = { a: 1 }; } }');
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzn#13] declare and static operands use P3 for as and satisfies; declaration and static field controls retain P2',
  () => {
    operandCases('declare', 'declare const declared: typeof value; const value = { a: 1 };');
    operandCases('static', 'class Holder { static value = { a: 1 }; }');
  },
  SLOW,
);
