// Each top-level case contains a current misclassification plus unchanged-rule controls.
// Expected decisions are D10-1989's P1/P2/P3 rules, not the classifier's current output.
import { afterAll, it } from 'vitest';
import { SLOW, cleanup, fixture, typeMembers, valueMember } from './kit.ts';

afterAll(cleanup);

it(
  '[AC-CT-06zzzzzo#1] bodyless method parameter types reject required members, including declaration and overload controls',
  () => {
    const signatures = [
      'interface I { m(x: { a: number }): void; }',
      'abstract class A { abstract m(x: { a: number }): void; }',
      'type T = { m(x: { a: number }): void };',
      // These function-keyword signatures already have a params role; preserve that behavior.
      'declare function g(x: { a: number }): void;',
      'function overloaded(x: { a: number }): void;',
      'function overloaded(x: string): void;',
      'function overloaded(x: unknown): void { void x; }',
    ];
    const method = 'class C { m(x: { a: number }): void { void x; } }';
    const values = [
      'class Factory { m() { return { a: 1 }; } }',
      'declare function consume(x: unknown): void; consume({ a: 1 });',
      'const receiver = { m(x: unknown) {} }; receiver.m({ a: 1 });',
    ];
    const judge = fixture('signatures', [...signatures, method, ...values]);
    for (const row of signatures.slice(0, 5)) typeMembers(judge, row);
    typeMembers(judge, method);
    for (const row of values) valueMember(judge, row);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzo#2] function return object types use P3 while value arrow bodies retain P1',
  () => {
    const type = 'type F = () => { a: number };';
    const arrow = 'const f = () => { ping(); };';
    const judge = fixture('arrow-return', [type, arrow]);
    typeMembers(judge, type);
    judge(arrow, 'const f = () => { const extra = 2; ping(); };', true, 'const extra = 2;');
    judge(arrow, 'const f = () => { ping(); ping(); };', true, 'ping();');
    judge(arrow, 'const f = () => {\ndup = 2;\nping(); };', false, 'dup = 2;');
    judge(arrow, 'const f = () => {\nlet extra = 2;\nping(); };', false, 'let extra = 2;');
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzo#3] object-returning function checks preserve P3 in both conditional type branches',
  () => {
    const rows = [
      'type R<T> = T extends () => { a: 1 } ? [{ a: number }] : never;',
      'type S<T> = T extends () => { a: 1 } ? never : [{ a: number }];',
    ];
    const value = 'const v = cond ? [{ a: 1 }] : [];';
    const judge = fixture('conditional', [...rows, value]);
    for (const row of rows) typeMembers(judge, row);
    valueMember(judge, value);
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzo#4] an existing newline as call permits P2 tails but newly inserted as expressions remain refused',
  () => {
    const call = 'export const v = raw\nas({ a: 1 });';
    const generic = 'const typed = raw\nas<[{ a: number }]>(raw);';
    const judge = fixture('newline-as', ['declare function as<T>(x: T): T;', call, generic]);
    valueMember(judge, call);
    typeMembers(judge, generic);

    // Here the whole second statement is new, unlike the call already present above.
    const baseline = 'export const v = raw\n';
    const insert = fixture('inserted-as', ['declare function as<T>(x: T): T;', baseline]);
    for (const added of ['as(dup = 2)', 'as < 1, dup = 2', 'as < 1', 'as({ a: 1, b: 2 })']) {
      insert(baseline, `${baseline}${added}\n`, false, added);
    }
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzo#5] an interface body after a defaulted type parameter permits only optional member additions',
  () => {
    const rows = [
      'interface I<T = { a: number }> { value: T; }',
      'interface J<U, T = [{ a: number }]> { value: T; }',
    ];
    const judge = fixture('interface-body', rows);
    for (const row of rows) {
      typeMembers(judge, row, '{ value: T; }');
      // Existing CT-06zzzzzn#5 also pins the default itself as a type.
      typeMembers(judge, row);
      for (const optional of [true, false]) {
        const inserted = `b${optional ? '?' : ''}: string;`;
        judge(row, row.replace('{ value: T; }', `{\n${inserted}\nvalue: T; }`), optional, inserted);
      }
    }
  },
  SLOW,
);

it(
  '[AC-CT-06zzzzzo#6] an insertion into as[n] is refused as an index, preserving array diagnostic controls',
  () => {
    const indexed = 'const v = as[n];';
    const control = 'const other = raw[n];';
    const array = 'const values = [n];';
    const judge = fixture('as-index', [
      'declare const as: number[];',
      'declare const n: number;',
      indexed,
      control,
      array,
    ]);
    for (const row of [indexed, control]) {
      judge(row, row.replace('[n]', '[n\n+ 1\n]'), false, '+ 1', 'an index');
    }
    judge(array, array.replace('[n]', '[n\n, 1\n]'), false, ', 1', 'an existing array');
  },
  SLOW,
);
