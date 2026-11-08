// Motion timings for script code (timers), from the generated duration tokens (规划/03 §10.6):
// components never write milliseconds themselves. CSS keeps using the var(--motion-*) variables.
import { motionMs } from '@couli/ui-tokens';

const { skeleton, toast } = motionMs.motion;

/** Loading shorter than this never shows a skeleton (motion.skeleton.show-delay). */
export const SKELETON_SHOW_DELAY_MS: number = skeleton['show-delay'];
/** A skeleton, once shown, stays at least this long (motion.skeleton.min-visible). */
export const SKELETON_MIN_VISIBLE_MS: number = skeleton['min-visible'];
/** How long a light notice stays (motion.toast.display). */
export const TOAST_DISPLAY_MS: number = toast.display;
