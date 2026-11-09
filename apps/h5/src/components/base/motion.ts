// Motion timings for script code (timers), from the generated duration tokens (规划/03 §10.6):
// components never write milliseconds themselves. CSS keeps using the var(--motion-*) variables.
// The standalone constants (not the motionMs object) keep the shared bundle small.
import {
  motionDurationEmphasizedMs,
  motionDurationNormalMs,
  motionSkeletonMinVisibleMs,
  motionSkeletonShowDelayMs,
  motionToastDisplayMs,
} from '@couli/ui-tokens';

/** Loading shorter than this never shows a skeleton (motion.skeleton.show-delay). */
export const SKELETON_SHOW_DELAY_MS: number = motionSkeletonShowDelayMs;
/** A skeleton, once shown, stays at least this long (motion.skeleton.min-visible). */
export const SKELETON_MIN_VISIBLE_MS: number = motionSkeletonMinVisibleMs;
/** How long a light notice stays (motion.toast.display). */
export const TOAST_DISPLAY_MS: number = motionToastDisplayMs;
/**
 * A closing dialog or sheet stays in its portal this long, then is removed: its exit motion
 * (shared/styles/index.css, shorter than the enter) has finished by then. Timers only, never
 * transitionend (DSX-48d).
 */
export const MODAL_EXIT_MS: number = motionDurationEmphasizedMs;
/** A light notice starts fading out this long before it is removed (motion.duration.normal). */
export const TOAST_EXIT_MS: number = motionDurationNormalMs;
