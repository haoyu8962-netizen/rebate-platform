// DSX-48c: names and props of the H5 image component the rule tests rely on. Types and plain
// constants only, so every test environment (node, jsdom, browser) can import it.
import type { HTMLAttributeReferrerPolicy } from 'react';

/** Export name of the image component in apps/h5/src/components/base/index.ts. */
export const IMAGE_EXPORT = 'AsyncImage';

/**
 * Props of `AsyncImage` (手感方案 ④, design/ui-rules §3.6, 规划/03 §10.6).
 *
 * Rendering: one frame element marked `data-slot="image-frame"` (a block that fills its
 * container's width) carries the state in `data-state`:
 * - `loading`: the frame shows the placeholder (a token background colour) and keeps its size;
 *   the `<img>` is already in the DOM (so the browser loads it) with `loading="lazy"`,
 *   `decoding="async"`, `src` and `alt`, its accessible name is `alt`, and it is not shown yet
 *   (opacity 0). No text, no `aria-busy="true"` and no `data-slot="skeleton-block"` (the frozen
 *   page tests read those two as "the page is still loading").
 * - `loaded` (after the img's `load` event): the image fades in with opacity, duration
 *   `var(--motion-duration-normal)` and easing `var(--motion-easing-enter)`; under
 *   `prefers-reduced-motion: reduce` it shows at once.
 * - `error` (after the img's `error` event): the placeholder plus a readable failure text
 *   (`failedText`, else the dictionary's `state.load_failed.title`); the `<img>` is removed or
 *   carries `hidden`, so no broken-image icon shows.
 * - `empty` (`src` null / undefined / ''): the placeholder frame only; no `<img>`, no request.
 * A new `src` starts again at `loading`.
 */
export interface AsyncImageProps {
  src: string | null | undefined;
  /** The img's alternative text and accessible name ('' for a decorative image). */
  alt: string;
  /** CSS aspect-ratio the frame keeps in every state, e.g. '3 / 2'. */
  aspectRatio?: string;
  /** Passed through to the img (article images use 'no-referrer'). */
  referrerPolicy?: HTMLAttributeReferrerPolicy;
  /** Failure text; defaults to the dictionary text of `state.load_failed.title`. */
  failedText?: string;
  /** Extra layout classes for the frame. */
  className?: string;
}

export const FRAME = '[data-slot="image-frame"]';
export type ImageState = 'loading' | 'loaded' | 'error' | 'empty';

/** Frozen page tests treat these as "still loading" once content is shown. */
export const PAGE_BUSY = '[aria-busy="true"], [data-slot="skeleton-block"]';

/** CJK ideographs (the H5 lint rule's range): component sources carry no inline Chinese. */
export const CJK = /[㐀-䶿一-鿿]/u;
