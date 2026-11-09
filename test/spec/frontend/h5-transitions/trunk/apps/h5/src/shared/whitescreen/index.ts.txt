// H5 white-screen detection (规划/03 §8.3, 01 F-H5-04): 3 seconds after the first screen, an empty
// key node is reported with URL path, platform and version only (01 F-OBS-01 whitelist).

export interface WhitescreenReport {
  kind: 'whitescreen';
  path: string;
  platform: string | null;
  version: string | null;
  elapsed_ms: number;
}

export interface WhitescreenOptions {
  root: HTMLElement;
  report: (event: WhitescreenReport) => void;
  /** Read when the deadline fires, so an environment resolved later (app.getEnv) is reported. */
  env: { platform: string | null; version: string | null };
  timeoutMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => number;
  clearTimeout?: (handle: number) => void;
}

const DEFAULT_TIMEOUT_MS = 3000;

/** Subtrees that never paint page content. */
const NON_RENDERED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);
/** Graphic elements count as rendered content even without text. */
const GRAPHICS = new Set(['IMG', 'SVG', 'CANVAS', 'PICTURE', 'VIDEO']);

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function styleOf(element: Element): CSSStyleDeclaration | null {
  const view = element.ownerDocument.defaultView;
  return view === null ? null : view.getComputedStyle(element);
}

/**
 * True when some visible text node or graphic element lies under `element`. Hidden subtrees
 * (`hidden`, display:none) are skipped; visibility is inherited and a child may override it.
 * Form control values are not text nodes, so input contents never count (or leave the page).
 */
function hasVisibleContent(element: Element, parentVisible: boolean): boolean {
  if (NON_RENDERED.has(element.tagName.toUpperCase())) return false;
  if (element.hasAttribute('hidden')) return false;
  const style = styleOf(element);
  if (style?.display === 'none') return false;
  const visibility = style?.visibility ?? '';
  let visible = parentVisible;
  if (visibility === 'hidden' || visibility === 'collapse') visible = false;
  else if (visibility === 'visible') visible = true;
  if (visible && GRAPHICS.has(element.tagName.toUpperCase())) return true;
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (visible && (child.textContent ?? '').trim().length > 0) return true;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (hasVisibleContent(child as Element, visible)) return true;
    }
  }
  return false;
}

/** White screen: the root has no element child, or nothing visible (text or graphics) inside. */
export function isWhitescreen(root: HTMLElement): boolean {
  if (root.childElementCount === 0) return true;
  for (const child of root.children) {
    if (hasVisibleContent(child, true)) return false;
  }
  return true;
}

/**
 * Checks `root` once after `timeoutMs` (default 3000) and reports at most once if it is white.
 * The returned function cancels the pending check; calling it again is a no-op.
 */
export function startWhitescreenWatch(options: WhitescreenOptions): () => void {
  const { root, report, env } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? defaultNow;
  const schedule = options.setTimeout ?? ((callback, delay) => window.setTimeout(callback, delay));
  const unschedule = options.clearTimeout ?? ((handle) => window.clearTimeout(handle));
  const startedAt = now();
  let active = true;

  const handle = schedule(() => {
    if (!active) return;
    active = false;
    if (!isWhitescreen(root)) return;
    // Whitelisted fields only: the path excludes query string and hash (tokens, anchors).
    report({
      kind: 'whitescreen',
      path: window.location.pathname,
      platform: env.platform,
      version: env.version,
      elapsed_ms: Math.round(now() - startedAt),
    });
  }, timeoutMs);

  return () => {
    if (!active) return;
    active = false;
    unschedule(handle);
  };
}
