// Motion timings for script code (timers), from the generated duration tokens (规划/03 §10.6):
// components never write milliseconds themselves. CSS keeps using the var(--motion-*) variables.
// The standalone constants (not the motionMs object) keep the shared bundle small.
import {
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
