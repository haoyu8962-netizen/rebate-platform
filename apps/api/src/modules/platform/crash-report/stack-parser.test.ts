import { createStackParser } from '@sentry/core';
import { expect, it } from 'vitest';
import { nodeStackLineParser, parseNodeStackLine } from './stack-parser.ts';

it('[AC-QA-13d#5] a named frame gives file, function, line, column and in_app', () => {
  expect(parseNodeStackLine('    at handle (/srv/app/dist/orders/handler.js:42:13)')).toEqual({
    filename: '/srv/app/dist/orders/handler.js',
    function: 'handle',
    lineno: 42,
    colno: 13,
    in_app: true,
  });
});

it('[AC-QA-13d#5] async frames with a file URL become paths', () => {
  expect(parseNodeStackLine('    at async run (file:///srv/app/dist/entry.js:7:5)')).toEqual({
    filename: '/srv/app/dist/entry.js',
    function: 'run',
    lineno: 7,
    colno: 5,
    in_app: true,
  });
});

it('[AC-QA-13d#5] an anonymous frame has the unknown function name', () => {
  expect(parseNodeStackLine('    at /srv/app/dist/main.js:3:9')).toEqual({
    filename: '/srv/app/dist/main.js',
    function: '?',
    lineno: 3,
    colno: 9,
    in_app: true,
  });
});

it('[AC-QA-13d#5] aliases, constructors and node_modules / node: frames', () => {
  expect(
    parseNodeStackLine('    at Object.method [as alias] (/srv/app/node_modules/x/i.js:1:2)'),
  ).toMatchObject({ function: 'Object.method', in_app: false, lineno: 1, colno: 2 });
  expect(parseNodeStackLine('    at new Thing (/srv/app/a.js:5:6)')).toMatchObject({
    function: 'new Thing',
    in_app: true,
  });
  const internal = '    at process.tick (node:internal/process/task_queues:95:5)';
  expect(parseNodeStackLine(internal)).toMatchObject({
    filename: 'node:internal/process/task_queues',
    lineno: 95,
    in_app: false,
  });
});

it('[AC-QA-13d#5] eval frames take the evaluated position; native frames have no file', () => {
  expect(
    parseNodeStackLine('    at eval (eval at outer (/srv/app/a.js:1:2), <anonymous>:3:4)'),
  ).toMatchObject({ function: 'eval', filename: '<anonymous>', lineno: 3, colno: 4 });
  expect(parseNodeStackLine('    at Array.map (native)')).toEqual({
    function: 'Array.map',
    in_app: false,
  });
});

it('[AC-QA-13d#5] lines that are not frames give nothing', () => {
  expect(parseNodeStackLine('Error: boom')).toBeUndefined();
  expect(parseNodeStackLine('some text at the end')).toBeUndefined();
  expect(parseNodeStackLine('')).toBeUndefined();
});

it('[AC-QA-13d#5] with createStackParser a whole stack becomes frames, oldest first', () => {
  const parse = createStackParser(nodeStackLineParser);
  const lines = ['Error: boom', '    at inner (/srv/app/a.js:1:1)', '    at outer (/srv/b.js:2:2)'];
  const frames = parse(lines.join('\n'));
  expect(frames.map((frame) => frame.function)).toEqual(['outer', 'inner']);
});
