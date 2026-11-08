// DSX-48 / DSX-108: the motion group of design tokens v0.5.2, written out by hand from
// docs/changes/20261107-Web动效令牌.md §1 and 规划/03 §10.6 (planning repository at SPEC_REF), not
// read from the generator or the implementation snapshot. No Node or DOM imports: the Node,
// jsdom and browser rule tests all read it.

/** Token version and the planning commit the contracts snapshot is copied from. */
export const TOKENS_VERSION = '0.5.2';
export const DESIGN_SOURCE_COMMIT = 'c98ae93f5daf3b8d04671ee903b8f28fd805b72f';
/**
 * The previous snapshot (v0.5.1). Kept under test/spec/frontend/ui-tokens/fixtures as the base of
 * the upgrade check there ([AC-DSX-48-UPGRADE#1]) and of the generator probes here (TOKENS#4).
 */
export const PREVIOUS_SOURCE_COMMIT = 'f088f0473230d1e70232b8a246b92ef53d723929';
export const PREVIOUS_SNAPSHOT = 'test/spec/frontend/ui-tokens/fixtures/design-tokens.f088f04.json';

export interface MotionLeaf {
  /** Token path, dot separated. */
  path: string;
  type: 'duration' | 'cubicBezier';
  /** `value` in design-tokens.json: milliseconds (duration) or [x1, y1, x2, y2] (cubicBezier). */
  value: number | readonly number[];
  /** Expected CSS value, spelled like the planning sync-brand.py (`250ms`, `cubic-bezier(…)`). */
  css: string;
}

export const MOTION_LEAVES: readonly MotionLeaf[] = [
  { path: 'motion.duration.instant', type: 'duration', value: 0, css: '0ms' },
  { path: 'motion.duration.fast', type: 'duration', value: 150, css: '150ms' },
  { path: 'motion.duration.normal', type: 'duration', value: 250, css: '250ms' },
  { path: 'motion.duration.emphasized', type: 'duration', value: 350, css: '350ms' },
  { path: 'motion.duration.slow', type: 'duration', value: 500, css: '500ms' },
  {
    path: 'motion.easing.standard',
    type: 'cubicBezier',
    value: [0.2, 0, 0, 1],
    css: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  {
    path: 'motion.easing.enter',
    type: 'cubicBezier',
    value: [0, 0, 0, 1],
    css: 'cubic-bezier(0, 0, 0, 1)',
  },
  {
    path: 'motion.easing.exit',
    type: 'cubicBezier',
    value: [0.3, 0, 1, 1],
    css: 'cubic-bezier(0.3, 0, 1, 1)',
  },
  {
    path: 'motion.easing.emphasized-enter',
    type: 'cubicBezier',
    value: [0.05, 0.7, 0.1, 1],
    css: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  },
  {
    path: 'motion.easing.emphasized-exit',
    type: 'cubicBezier',
    value: [0.3, 0, 0.8, 0.15],
    css: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  },
  { path: 'motion.toast.display', type: 'duration', value: 2000, css: '2000ms' },
  { path: 'motion.skeleton.shimmer', type: 'duration', value: 1500, css: '1500ms' },
  { path: 'motion.skeleton.show-delay', type: 'duration', value: 300, css: '300ms' },
  { path: 'motion.skeleton.min-visible', type: 'duration', value: 300, css: '300ms' },
  { path: 'motion.reduced.fade', type: 'duration', value: 150, css: '150ms' },
];

/** Canonical CSS variable of a token path (motion.skeleton.show-delay → --motion-skeleton-show-delay). */
export function cssVariable(path: string): string {
  return `--${path.split('.').join('-')}`;
}

/** Skeleton timings (motion.skeleton.*), milliseconds. */
export const SHOW_DELAY_MS = 300;
export const MIN_VISIBLE_MS = 300;
export const SHIMMER_MS = 1500;

/** CSS system colours (CSS Color 4 §6.2) that a forced-colors rule may use. */
export const SYSTEM_COLOR =
  /\b(?:Canvas|CanvasText|LinkText|VisitedText|ActiveText|ButtonFace|ButtonText|ButtonBorder|Field|FieldText|Highlight|HighlightText|SelectedItem|SelectedItemText|Mark|MarkText|GrayText|AccentColor|AccentColorText)\b/;

/** The skeleton block every Skeleton renders (F1-01f). */
export const SKELETON_BLOCK = '[data-slot="skeleton-block"]';
