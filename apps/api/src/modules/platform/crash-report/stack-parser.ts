// Node (V8) stack-line parser of crash reporting (QA-13d ②): @sentry/core's createStackParser needs
// one line parser per runtime, and the core package's own export is not used here. One line such as
// `    at async handle (/srv/app/x.js:42:13)` becomes a Sentry stack frame (file, function, line,
// column, in_app); lines that are not frames (the `Error: …` header, free text) give nothing.
import { fileURLToPath } from 'node:url';
import type { StackFrame, StackLineParser, StackLineParserFn } from '@sentry/core';

/** Sentry's name of a frame without a function name. */
const UNKNOWN_FUNCTION = '?';

/** `at [async ]<function> (<location>)` or `at [async ]<location>`. */
const FRAME_LINE = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\((.+)\)|(.+?))\s*$/;
/** `<file>:<line>:<column>` or `<file>:<line>`. */
const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;

function functionName(raw: string | undefined): string {
  if (raw === undefined) return UNKNOWN_FUNCTION;
  // `Object.method [as alias]`: the alias names the property, the function keeps its own name.
  const name = raw.replace(/\s+\[as [^\]]+\]$/, '').trim();
  return name === '' || name === '<anonymous>' ? UNKNOWN_FUNCTION : name;
}

/** File URLs become paths, so frames read the same under ESM and CommonJS. */
function fileName(raw: string): string {
  if (!raw.startsWith('file://')) return raw;
  try {
    return fileURLToPath(raw);
  } catch {
    return raw;
  }
}

function isInApp(filename: string): boolean {
  if (filename.includes('/node_modules/') || filename.includes('\\node_modules\\')) return false;
  if (filename.startsWith('node:') || filename.startsWith('internal/')) return false;
  return filename.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filename);
}

/** One V8 stack line → a frame; undefined for anything else. */
export const parseNodeStackLine: StackLineParserFn = (line: string): StackFrame | undefined => {
  const match = FRAME_LINE.exec(line);
  if (match === null) return undefined;
  const fn = match[1];
  let location = (match[2] ?? match[3] ?? '').trim();
  // `eval at outer (file:1:2), <anonymous>:3:4`: the position inside the evaluated code.
  if (location.startsWith('eval at ')) {
    const last = location.lastIndexOf(', ');
    location = last === -1 ? location : location.slice(last + 2);
  }
  if (location === '' || location === 'native') {
    return { function: functionName(fn ?? location), in_app: false };
  }
  const position = LOCATION.exec(location);
  const filename = fileName(position === null ? location : (position[1] ?? location));
  const frame: StackFrame = {
    filename,
    function: functionName(match[3] === undefined ? fn : undefined),
    in_app: isInApp(filename),
  };
  if (position?.[2] !== undefined) frame.lineno = Number(position[2]);
  if (position?.[3] !== undefined) frame.colno = Number(position[3]);
  return frame;
};

/** The line parser handed to createStackParser (Sentry's priority for Node parsers). */
export const nodeStackLineParser: StackLineParser = [90, parseNodeStackLine];
