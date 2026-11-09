// DSX-48d (手感方案 ⑦, 编排 D10-1032; 规划/03 §10.6 items 1–3, 5, 8; design/ui-rules §3.3): names,
// selectors and bounds the transition rule tests rely on. Plain constants and types only, so the
// Node, jsdom and browser tests can all import it.

/** Properties a transition or animation may move (规划/03 §10.6 item 3: "只动 opacity 与 transform"). */
export const MOTION_PROPERTIES: readonly string[] = [
  'opacity',
  'transform',
  'translate',
  'scale',
  'rotate',
];

/** The transform family among MOTION_PROPERTIES (位移 / 缩放). */
export const TRANSFORM_PROPERTIES: readonly string[] = [
  'transform',
  'translate',
  'scale',
  'rotate',
];

/**
 * Discrete helpers a transition may list next to opacity / transform so an element can leave
 * through display:none or the top layer (`transition-behavior: allow-discrete`). They never
 * animate visibly, so the tests ignore them.
 */
export const DISCRETE_PROPERTIES: readonly string[] = [
  'display',
  'overlay',
  'visibility',
  'content-visibility',
];

/**
 * Exit duration / enter duration for dialogs and sheets ("退出比进入短（约 2/3）"). The bounds
 * admit token pairs (normal / emphasized ≈ 0.71) and calc(… * 2 / 3) alike.
 */
export const EXIT_RATIO = { min: 0.5, max: 0.8 } as const;

/** Dialog start scale ("淡入加轻微放大", scale 约 0.95 → 1). */
export const DIALOG_START_SCALE = { min: 0.85, max: 0.99 } as const;

/** A dialog does not slide: its centre moves by at most this share of its height. */
export const DIALOG_MAX_SHIFT = 0.1;

/** A sheet slides in from below by at least this share of its own height ("从下滑入"). */
export const SHEET_MIN_TRAVEL = 0.5;

/** A fade starts (enter) or ends (exit) at most this opaque. */
export const FADE_EDGE = 0.5;
/** An exit fade ends at most this opaque ("淡出"). */
export const FADED_OUT = 0.1;
/** Fully shown. */
export const SHOWN = 0.99;

/** Parts of the modal frame (frozen F1-01f contract, components/base/types.ts). */
export const BACKDROP = '[data-slot="modal-backdrop"]';
export const SKELETON_BLOCK = '[data-slot="skeleton-block"]';
export const TOAST_REGION = '[data-slot="toast-region"]';

/** Keyframes of the frozen DSX-48 skeleton shimmer (background-position sweep), left as they are. */
export const FROZEN_KEYFRAMES: readonly string[] = ['h5-skeleton-shimmer'];

/** One motion token and the spellings that reference it in H5 sources. */
export interface TokenReference {
  token: string;
  /** CSS variable, Tailwind alias of @couli/ui-tokens tailwind.css, or ui-tokens TS constant. */
  aliases: readonly string[];
}

/**
 * Tokens the overlay transitions need and that the H5 shared code did not use before DSX-48d:
 * dialogs and sheets (emphasized duration, emphasized-enter / emphasized-exit easing), exits
 * (exit easing) and reduced motion (motion.reduced.fade).
 */
export const REQUIRED_TOKENS: readonly TokenReference[] = [
  {
    token: 'motion.duration.emphasized',
    aliases: [
      '--motion-duration-emphasized',
      'duration-couli-duration-emphasized',
      'motionDurationEmphasizedMs',
    ],
  },
  {
    token: 'motion.easing.emphasized-enter',
    aliases: ['--motion-easing-emphasized-enter', 'ease-couli-emphasized-enter'],
  },
  {
    token: 'motion.easing.emphasized-exit',
    aliases: ['--motion-easing-emphasized-exit', 'ease-couli-emphasized-exit'],
  },
  {
    token: 'motion.easing.exit',
    aliases: ['--motion-easing-exit', 'ease-couli-exit'],
  },
  {
    token: 'motion.reduced.fade',
    aliases: ['--motion-reduced-fade', 'duration-couli-reduced-fade', 'motionReducedFadeMs'],
  },
];

/** Tailwind transition utilities that keep to opacity / transform (or set no property). */
export const ALLOWED_TRANSITION_UTILITIES: readonly string[] = [
  'transition-opacity',
  'transition-transform',
  'transition-none',
  'transition-discrete',
  'transition-normal',
];
