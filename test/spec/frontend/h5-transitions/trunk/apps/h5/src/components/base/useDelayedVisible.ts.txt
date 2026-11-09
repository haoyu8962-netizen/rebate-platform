import { useEffect, useRef, useState } from 'react';
import { SKELETON_MIN_VISIBLE_MS, SKELETON_SHOW_DELAY_MS } from './motion.ts';

/**
 * Anti-flash for skeletons (规划/03 §10.6 item 7, ui-rules §2 L2): true while the skeleton should
 * be on screen. Loading that ends within motion.skeleton.show-delay never shows it; once shown it
 * stays at least motion.skeleton.min-visible, even if loading has ended. While this is false and
 * `loading` is still true, render an empty busy region (`aria-busy="true"`), not the content.
 */
export function useDelayedVisible(loading: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (loading) {
      // Already shown: keep it (a hold timer of an earlier load is cleared by the cleanup).
      if (visible) return undefined;
      const timer = setTimeout(() => {
        shownAt.current = performance.now();
        setVisible(true);
      }, SKELETON_SHOW_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (!visible) return undefined;
    const remaining = shownAt.current + SKELETON_MIN_VISIBLE_MS - performance.now();
    if (remaining <= 0) {
      setVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [loading, visible]);

  return visible;
}
