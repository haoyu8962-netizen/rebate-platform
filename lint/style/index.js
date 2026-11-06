// LINT-STYLE-web (规划/05 §3.11.3, D10-643 ⑧): ESLint rules that keep hard-coded styles out of
// apps/h5 and apps/admin page code, plus the processor that applies the shrink-only baseline.
//   couli-style/no-arbitrary-value   Tailwind arbitrary values holding a literal (text-[13px])
//   couli-style/no-small-brand-text  caption / footnote text in text-couli-brand-primary
//   couli-style/no-numeric-style     numeric fontSize / border*Radius / margin* / padding*
//   couli-style/no-hex-color         hex colours in strings (style objects, TSX, ui.setNavBar …)
//   couli-style/exemption-reason     an eslint-disable of a couli-style rule without `-- reason`
// The rules are syntactic: they need no type information. An exception is written as ESLint's own
// `eslint-disable-next-line couli-style/<rule> -- <reason>`.
//
// baseline.json maps rule id → repo-relative file → count of the violations that file still has.
// The `couli-style/baseline` processor drops a rule's reports in a file while their count is at
// most the recorded one, and keeps all of them once it is exceeded; any other file gets every
// report. Counts only ever go down: fix a violation, then lower (or delete) its entry.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'couli-style/';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_FILE = resolve(REPO, 'lint/style/baseline.json');

// --- string literals -------------------------------------------------------------------------

/** True for a string written in a type (`'a' | 'b'`, `` `x${string}` ``) or as a module name. */
function notAValue(node) {
  const parent = node.parent;
  if (parent === undefined || parent === null) return false;
  if (parent.type === 'TSLiteralType' || parent.type === 'TSTemplateLiteralType') return true;
  if (parent.type === 'TSImportType' || parent.type === 'TSExternalModuleReference') return true;
  return (
    (parent.type === 'ImportDeclaration' ||
      parent.type === 'ExportNamedDeclaration' ||
      parent.type === 'ExportAllDeclaration' ||
      parent.type === 'ImportExpression') &&
    parent.source === node
  );
}

/** Calls `visit(node, text)` for every string literal and template part that is a value. */
function stringVisitors(visit) {
  return {
    Literal(node) {
      if (typeof node.value === 'string' && !notAValue(node)) visit(node, node.value);
    },
    TemplateElement(node) {
      const template = node.parent;
      if (template?.type !== 'TemplateLiteral') return;
      visit(node, node.value.cooked ?? node.value.raw);
    },
  };
}

function classesOf(text) {
  return text.split(/\s+/).filter((cls) => cls !== '');
}

/** The utility of a class without its variants (`focus-visible:`, `before:` …). */
function utilityOf(cls) {
  let depth = 0;
  for (let i = cls.length - 1; i >= 0; i -= 1) {
    const ch = cls[i];
    if (ch === ']' || ch === ')') depth += 1;
    else if (ch === '[' || ch === '(') depth -= 1;
    else if (ch === ':' && depth === 0) return cls.slice(i + 1);
  }
  return cls;
}

// --- no-arbitrary-value ----------------------------------------------------------------------

const ARBITRARY = /^!?-?[a-z][a-z\d-]*-\[([^\]]+)\]!?$/;
const LITERAL_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw|dvh|svh|lvh)?$/i;
const HEX_ANYWHERE = /#[\da-f]{3,8}\b/i;
const LENGTH_ANYWHERE = /(?<![\w-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)\b/i;

/** A Tailwind arbitrary value holding a literal length, percentage or hex (not a var()). */
function literalArbitrary(cls) {
  const match = ARBITRARY.exec(utilityOf(cls));
  if (match === null) return false;
  const value = match[1] ?? '';
  return LITERAL_LENGTH.test(value) || HEX_ANYWHERE.test(value) || LENGTH_ANYWHERE.test(value);
}

const noArbitraryValue = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow Tailwind arbitrary values with literal lengths or colours.' },
    schema: [],
    messages: {
      arbitrary:
        'Tailwind arbitrary value `{{cls}}`: use a couli token class (规划/05 §3.11.3), or exempt it with `eslint-disable-next-line … -- <reason>`.',
    },
  },
  create(context) {
    return stringVisitors((node, text) => {
      for (const cls of classesOf(text)) {
        if (literalArbitrary(cls)) context.report({ node, messageId: 'arbitrary', data: { cls } });
      }
    });
  },
};

// --- no-small-brand-text ---------------------------------------------------------------------

const BRAND_TEXT = 'text-couli-brand-primary';
const SMALL_TEXT = new Set(['text-couli-caption', 'text-couli-footnote']);

function smallBrand(classes) {
  return classes.includes(BRAND_TEXT) && classes.some((cls) => SMALL_TEXT.has(cls));
}

const noSmallBrandText = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow caption / footnote text in text-couli-brand-primary.' },
    schema: [],
    messages: {
      small:
        'Small text (caption / footnote) in text-couli-brand-primary is below 4.5:1: use text-couli-text-link or text-couli-brand-emphasis (规划/05 §3.11.3).',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string' || notAValue(node)) return;
        if (smallBrand(classesOf(node.value))) context.report({ node, messageId: 'small' });
      },
      TemplateLiteral(node) {
        if (node.parent?.type === 'TSTemplateLiteralType') return;
        const classes = node.quasis.flatMap((quasi) =>
          classesOf(quasi.value.cooked ?? quasi.value.raw),
        );
        if (smallBrand(classes)) context.report({ node, messageId: 'small' });
      },
    };
  },
};

// --- no-numeric-style ------------------------------------------------------------------------

const SIZE_PROPERTY =
  /^(?:fontSize|border(?:[A-Z][a-z]+)*Radius|margin(?:[A-Z][a-z]*)*|padding(?:[A-Z][a-z]*)*)$/;
const LENGTH_PART = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)?$/i;

function propertyName(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string')
    return property.key.value;
  return null;
}

function numberOf(node) {
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (
    node.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument.type === 'Literal' &&
    typeof node.argument.value === 'number'
  )
    return -node.argument.value;
  return null;
}

/** A number other than 0, or a string of literal lengths (`'0 24px'`) that is not all zero. */
function hardCodedSize(value) {
  const number = numberOf(value);
  if (number !== null) return number !== 0;
  if (value.type !== 'Literal' || typeof value.value !== 'string') return false;
  const parts = value.value.trim().split(/\s+/);
  if (parts.length === 0 || !parts.every((part) => LENGTH_PART.test(part))) return false;
  return parts.some((part) => Number.parseFloat(part) !== 0);
}

const noNumericStyle = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow literal font sizes, radii, margins and paddings.' },
    schema: [],
    messages: {
      numeric:
        '`{{name}}` is a literal size: read it from @couli/ui-tokens or the antd theme token (规划/05 §3.11.3).',
    },
  },
  create(context) {
    return {
      Property(node) {
        if (node.parent?.type !== 'ObjectExpression' || node.kind !== 'init') return;
        const name = propertyName(node);
        if (name === null || !SIZE_PROPERTY.test(name)) return;
        if (hardCodedSize(node.value))
          context.report({ node, messageId: 'numeric', data: { name } });
      },
    };
  },
};

// --- no-hex-color ----------------------------------------------------------------------------

// `#` not after a word character or `&` (entities), 3 / 4 / 6 / 8 hex digits, then no word
// character: `#fff`, `1px solid #E4DED5`, `bg-[#FBEFE8]`; not `#/orders` or `#top`.
const HEX_COLOR = /(?<![\w&])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])/i;

const noHexColor = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hex colours in front-end source.' },
    schema: [],
    messages: {
      hex: 'Hex colour `{{hex}}`: use a colour token from @couli/ui-tokens (规划/05 §3.11.3).',
    },
  },
  create(context) {
    return stringVisitors((node, text) => {
      const match = HEX_COLOR.exec(text);
      if (match !== null) context.report({ node, messageId: 'hex', data: { hex: match[0] } });
    });
  },
};

// --- exemption-reason ------------------------------------------------------------------------

const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?:\s|$)/;

const exemptionReason = {
  meta: {
    type: 'problem',
    docs: { description: 'Require a reason on every eslint-disable of a couli-style rule.' },
    schema: [],
    messages: {
      reason:
        'An exemption from a couli-style rule needs a reason: `eslint-disable-next-line couli-style/<rule> -- <reason>`.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value;
          if (!DIRECTIVE.test(text)) continue;
          const [rules = '', ...reason] = text.split(/\s--\s|\s--$/);
          if (!rules.includes(PREFIX)) continue;
          if (reason.join(' -- ').trim() === '')
            context.report({ loc: comment.loc, messageId: 'reason' });
        }
      },
    };
  },
};

// --- baseline --------------------------------------------------------------------------------

function readBaseline() {
  const parsed = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const baseline = new Map();
  for (const [rule, files] of Object.entries(parsed)) {
    baseline.set(rule, new Map(Object.entries(files)));
  }
  return baseline;
}

const BASELINE = readBaseline();

function repoPath(filename) {
  return relative(REPO, filename).split(sep).join('/');
}

const baselineProcessor = {
  meta: { name: 'couli-style-baseline' },
  supportsAutofix: true,
  preprocess(text) {
    return [text];
  },
  postprocess(messageLists, filename) {
    const messages = messageLists.flat();
    const file = repoPath(filename);
    const counts = new Map();
    for (const message of messages) {
      const rule = message.ruleId;
      if (typeof rule === 'string' && rule.startsWith(PREFIX))
        counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
    return messages.filter((message) => {
      const rule = message.ruleId;
      if (typeof rule !== 'string' || !rule.startsWith(PREFIX)) return true;
      const allowed = BASELINE.get(rule)?.get(file) ?? 0;
      return (counts.get(rule) ?? 0) > allowed;
    });
  },
};

export const stylePlugin = {
  meta: { name: 'couli-style' },
  rules: {
    'no-arbitrary-value': noArbitraryValue,
    'no-small-brand-text': noSmallBrandText,
    'no-numeric-style': noNumericStyle,
    'no-hex-color': noHexColor,
    'exemption-reason': exemptionReason,
  },
  processors: { baseline: baselineProcessor },
};

/** Every couli-style rule as an error. */
export const styleRules = Object.fromEntries(
  Object.keys(stylePlugin.rules).map((name) => [`${PREFIX}${name}`, 'error']),
);
