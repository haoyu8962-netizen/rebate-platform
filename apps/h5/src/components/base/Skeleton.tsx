import type { CSSProperties, ReactElement } from 'react';
import { SKELETON_BLOCK } from './styles.ts';

export interface SkeletonProps {
  width: CSSProperties['width'];
  height: CSSProperties['height'];
}

/**
 * Busy wrapper contains one aria-hidden block with data-slot="skeleton-block". The block
 * shimmers (shared/styles/index.css, `h5-skeleton`); it renders at once, so a page that wants the
 * anti-flash delay decides when to render it with useDelayedVisible.
 */
export function Skeleton({ width, height }: SkeletonProps): ReactElement {
  return (
    <div aria-busy="true">
      <div
        data-slot="skeleton-block"
        aria-hidden="true"
        className={SKELETON_BLOCK}
        style={{ width, height }}
      />
    </div>
  );
}
