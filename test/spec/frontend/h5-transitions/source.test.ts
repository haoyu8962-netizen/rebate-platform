// DSX-48d source rules (手感方案 ⑦, 编排 D10-1032 ⑥; 规划/03 §10.6 items 1–3, 8: "页面与组件里不写死
// 毫秒数和贝塞尔值，一律取 --motion-* 变量", "只动 opacity 与 transform"). The frozen
// [AC-DSX-48-NO-HARDCODE#1] already bans millisecond, cubic-bezier() and Tailwind duration
// literals in apps/h5/src; this file adds what the overlay transitions bring:
// - SOURCE#1: the shared H5 code (components/base, shared) references the tokens dialogs, sheets,
//   exits and reduced motion take — emphasized duration, emphasized-enter / emphasized-exit and
//   exit easings, motion.reduced.fade — as CSS variables, @couli/ui-tokens Tailwind aliases or
//   ui-tokens TS constants; timers in base, shared and the find-order page take no number literal
//   as their delay (durations come from the named ui-tokens constants).
// - SOURCE#2: every transition and keyframes declared in the H5 CSS, and every transition class or
//   inline transition in base, shared and the find-order page, moves only opacity / transform
//   (translate / scale / rotate; discrete display / overlay / visibility helpers allowed), and
//   the sheet slide / dialog scale is declared there (a transform transition or keyframes).
// CSS is read without comments; TS / TSX through the TypeScript AST (strings, templates, JSX text,
// identifiers), so comments never count.
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  ALLOWED_TRANSITION_UTILITIES,
  DISCRETE_PROPERTIES,
  FROZEN_KEYFRAMES,
  MOTION_PROPERTIES,
  TRANSFORM_PROPERTIES,
} from './contract.ts';
import {
  cssBlocks,
  literalText,
  missingTokens,
  parse,
  readRepo,
  sourcesUnder,
  transitionProperties,
  utilityOf,
  walk,
  withoutComments,
} from './node-kit.ts';

const H5_STYLES = 'apps/h5/src/shared/styles/index.css';
const MODAL_FRAME = 'apps/h5/src/components/base/ModalFrame.tsx';
const SHARED = ['apps/h5/src/components/base', 'apps/h5/src/shared'];
const TASK = [...SHARED, 'apps/h5/src/entries/app/pages/find-order'];

/** Methods whose first argument names a property or an event, never a class list. */
const NAME_ARGUMENT_METHODS = new Set([
  'setProperty',
  'getPropertyValue',
  'removeProperty',
  'addEventListener',
  'removeEventListener',
]);

it('[AC-DSX-48d-SOURCE#1] H5 共用代码（components/base、shared）引用弹层与减弱动态所需令牌：--motion-duration-emphasized、--motion-easing-emphasized-enter / -exit、--motion-easing-exit、--motion-reduced-fade（CSS 变量、ui-tokens Tailwind 别名或具名常量均可）；base、shared 与找回页的计时器不以数字字面量作延时', () => {
  const files = sourcesUnder(SHARED);
  expect(files).toContain(MODAL_FRAME);
  expect(files).toContain(H5_STYLES);
  const missing = missingTokens(SHARED);

  const timers: string[] = [];
  for (const file of sourcesUnder(TASK).filter((path) => !path.endsWith('.css'))) {
    walk(parse(file, readRepo(file)), (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (name !== 'setTimeout' && name !== 'setInterval') return;
      const delay = node.arguments[1];
      if (
        delay !== undefined &&
        ts.isNumericLiteral(delay) &&
        Number(delay.text.replaceAll('_', '')) > 0
      ) {
        timers.push(`${file}: ${node.getText()}`);
      }
    });
  }
  expect(timers, 'timer delays written as number literals').toEqual([]);
  expect(missing, 'motion tokens not referenced by components/base or shared').toEqual([]);
});

it('[AC-DSX-48d-SOURCE#2] H5 样式里的 transition 与 @keyframes、base / shared / 找回页里的过渡类名与内联过渡只动 opacity / transform（离散的 display / overlay / visibility 可随行），且声明了 transform 过渡或关键帧（底部弹层滑入、对话框放大）', () => {
  const allowed = new Set([
    ...MOTION_PROPERTIES,
    ...DISCRETE_PROPERTIES,
    'none',
    'initial',
    'inherit',
    'unset',
    'revert',
    'revert-layer',
  ]);
  const violations: string[] = [];
  const transforms: string[] = [];
  const check = (where: string, properties: readonly string[]): void => {
    for (const property of properties) {
      if (!allowed.has(property)) violations.push(`${where}: ${property}`);
    }
    if (properties.some((property) => TRANSFORM_PROPERTIES.includes(property))) {
      transforms.push(where);
    }
  };

  const cssFiles = sourcesUnder(['apps/h5/src']).filter((file) => file.endsWith('.css'));
  expect(cssFiles).toContain(H5_STYLES);
  for (const file of cssFiles) {
    const css = withoutComments(readRepo(file));
    for (const block of cssBlocks(css, /@keyframes\s+([\w-]+)\s*\{/g)) {
      if (FROZEN_KEYFRAMES.includes(block.name)) continue;
      const properties = [...block.body.matchAll(/([a-z-]+)\s*:/gi)]
        .map((match) => (match[1] ?? '').toLowerCase())
        .filter((name) => name !== 'animation-timing-function' && name !== 'animation-composition');
      check(`${file} @keyframes ${block.name}`, properties);
    }
    for (const match of css.matchAll(/(?:^|[;{\s])(transition(?:-property)?)\s*:\s*([^;{}]+)/g)) {
      const value = (match[2] ?? '').trim();
      check(
        `${file} ${match[1]}: ${value}`,
        transitionProperties(value, match[1] === 'transition'),
      );
    }
  }

  const classToken = (file: string, token: string): void => {
    const utility = utilityOf(token);
    const arbitrary = /^\[(transition(?:-property)?):(.+)\]$/.exec(utility);
    if (arbitrary !== null) {
      const value = (arbitrary[2] ?? '').replaceAll('_', ' ');
      check(`${file} class ${token}`, transitionProperties(value, arbitrary[1] === 'transition'));
      return;
    }
    if (utility !== 'transition' && !utility.startsWith('transition-')) return;
    const list = /^transition-\[(.+)\]$/.exec(utility);
    if (list !== null) {
      check(
        `${file} class ${token}`,
        transitionProperties((list[1] ?? '').replaceAll('_', ' '), false),
      );
      return;
    }
    if (utility === 'transition-transform') {
      transforms.push(`${file} class ${token}`);
      return;
    }
    if (!ALLOWED_TRANSITION_UTILITIES.includes(utility)) {
      violations.push(`${file} class ${token}: transitions more than opacity / transform`);
    }
  };

  for (const file of sourcesUnder(TASK).filter((path) => !path.endsWith('.css'))) {
    const skipped = new Set<ts.Node>();
    walk(parse(file, readRepo(file)), (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier !== undefined) skipped.add(node.moduleSpecifier);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const [first, second] = node.arguments;
        if (first !== undefined && NAME_ARGUMENT_METHODS.has(method)) skipped.add(first);
        const name = first === undefined ? null : literalText(first);
        const value = second === undefined ? null : literalText(second);
        if (
          method === 'setProperty' &&
          value !== null &&
          (name === 'transition' || name === 'transition-property')
        ) {
          check(`${file} setProperty(${name})`, transitionProperties(value, name === 'transition'));
        }
      }
      if (ts.isPropertyAssignment(node)) {
        const key =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
        const value = literalText(node.initializer);
        if (
          value !== null &&
          (key === 'transition' || key === 'transitionProperty' || key === 'transition-property')
        ) {
          check(`${file} style ${key}`, transitionProperties(value, key === 'transition'));
        }
      }
      const text = literalText(node);
      if (text === null || skipped.has(node)) return;
      for (const token of text.split(/\s+/)) if (token !== '') classToken(file, token);
    });
  }

  expect(violations, 'transitions / keyframes that move more than opacity / transform').toEqual([]);
  expect(
    transforms,
    'a transform transition or keyframes (sheet slide, dialog scale) in the H5 styles or in base / shared / find-order',
  ).not.toEqual([]);
});
