// Every form and interactive control inside a root, each as "role: name" (F1-08aq,
// FU-F108AL-SHORTCUT-INPUTS / D10-2022). Wider than the frozen F1-08al list (button / a only):
// any checkbox, switch, radio, select, slider, date input, focusable element or clickable antd
// prefix / suffix / addon that could copy the amount due (or "now") into a row shows up here.

/** Explicit roles that make an element a control (a role attribute listing several roles counts too). */
const INTERACTIVE_ROLES = [
  'textbox',
  'searchbox',
  'spinbutton',
  'checkbox',
  'switch',
  'radio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'tab',
  'button',
  'link',
];

/** antd input prefix / suffix / addon areas (and the like on pickers, selects, number inputs). */
const AFFIX_AREAS = [
  '.ant-input-prefix',
  '.ant-input-suffix',
  '.ant-input-group-addon',
  '.ant-input-number-prefix',
  '.ant-input-number-suffix',
  '.ant-input-number-group-addon',
  '.ant-picker-suffix',
  '.ant-picker-clear',
  '.ant-select-arrow',
  '.ant-select-clear',
];

const SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  // Every <a>, also a bare one without href / role / tabindex (antd Typography.Link renders so).
  'a',
  ...INTERACTIVE_ROLES.map((role) => `[role~="${role}"]`),
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable]:not([contenteditable="false"])',
  ...AFFIX_AREAS,
  ...AFFIX_AREAS.map((area) => `${area} *`),
].join(', ');

/** The role of an `<input>` by its type; types not listed keep their own name (date, file, …). */
const INPUT_ROLES: Readonly<Record<string, string>> = {
  text: 'textbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  search: 'searchbox',
  number: 'spinbutton',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
};

function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

function isAffix(node: Element): boolean {
  return AFFIX_AREAS.some((area) => node.closest(area) !== null);
}

function roleOf(node: Element): string {
  const explicit = (node.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
  if (explicit !== '') return explicit;
  if (node instanceof HTMLInputElement) {
    if (node.hasAttribute('list')) return 'combobox';
    return INPUT_ROLES[node.type] ?? node.type;
  }
  if (node instanceof HTMLTextAreaElement) return 'textbox';
  if (node instanceof HTMLSelectElement)
    return node.multiple || node.size > 1 ? 'listbox' : 'combobox';
  if (node instanceof HTMLButtonElement) return 'button';
  if (node.localName === 'a') return 'link';
  if (isAffix(node)) return 'affix';
  const editable = node.getAttribute('contenteditable');
  if (editable !== null && editable !== 'false') return 'textbox';
  return 'focusable';
}

function labelsOf(node: Element): readonly HTMLLabelElement[] {
  if (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement ||
    node instanceof HTMLButtonElement
  ) {
    const list: NodeListOf<HTMLLabelElement> | null = node.labels;
    return list === null ? [] : Array.from(list);
  }
  return [];
}

/** aria-label → aria-labelledby text → associated label text → text content (whitespace removed). */
function nameOf(node: Element): string {
  const label = squash(node.getAttribute('aria-label') ?? '');
  if (label !== '') return label;
  const ids = (node.getAttribute('aria-labelledby') ?? '').trim();
  if (ids !== '') {
    const parts = ids.split(/\s+/).map((id) => node.ownerDocument.getElementById(id));
    const text = squash(parts.map((item) => item?.textContent ?? '').join(''));
    if (text !== '') return text;
  }
  const associated = squash(
    labelsOf(node)
      .map((item) => item.textContent ?? '')
      .join(''),
  );
  if (associated !== '') return associated;
  return squash(node.textContent ?? '');
}

/**
 * rc-dialog's two focus-trap sentinels: the plain `div tabIndex=0` direct children of the
 * role=dialog node (the first wraps the whole content, which is still searched).
 */
function isFocusSentinel(root: Element, node: Element): boolean {
  return (
    root.getAttribute('role') === 'dialog' &&
    node.parentElement === root &&
    node instanceof HTMLDivElement &&
    !node.hasAttribute('role') &&
    node.getAttribute('tabindex') === '0'
  );
}

/** The inner parts of an icon (svg path etc.); the icon element itself is still listed. */
function insideSvg(node: Element): boolean {
  return (node.parentElement?.closest('svg') ?? null) !== null;
}

function found(root: Element): Element[] {
  return Array.from(root.querySelectorAll(SELECTOR)).filter(
    (node) => !isFocusSentinel(root, node) && !insideSvg(node),
  );
}

function inert(node: Element): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.hasAttribute('readonly') ||
    node.getAttribute('aria-readonly') === 'true' ||
    node.closest('fieldset[disabled]') !== null
  );
}

function entryOf(node: Element): string {
  return `${roleOf(node)}: ${nameOf(node)}`;
}

/** All form and interactive controls inside `root`, as sorted "role: name" entries. */
export function controlsOf(root: Element): string[] {
  const entries = found(root).map((node) => entryOf(node));
  return entries.sort();
}

/** The controls of `controlsOf` that can be used now (not disabled, not read-only), sorted. */
export function operableOf(root: Element): string[] {
  const usable = found(root).filter((node) => !inert(node));
  return usable.map((node) => entryOf(node)).sort();
}
