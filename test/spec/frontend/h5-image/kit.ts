// DSX-48c test kit for the jsdom and browser tests: the image component read from base/index.ts
// at run time (a missing export fails as an assertion, not as a module load error) and DOM
// helpers. Nothing here reads the file system, so the browser test can import it too.
import type { ComponentType } from 'react';
import { expect } from 'vitest';
import * as Base from '../../../../apps/h5/src/components/base/index.ts';
import { FRAME, IMAGE_EXPORT, type AsyncImageProps } from './contract.ts';

export {
  CJK,
  FRAME,
  IMAGE_EXPORT,
  PAGE_BUSY,
  type AsyncImageProps,
  type ImageState,
} from './contract.ts';

/** Reads AsyncImage from base/index.ts and asserts it is a component before use. */
export function imageComponent(): ComponentType<AsyncImageProps> {
  const value: unknown = Reflect.get(Base, IMAGE_EXPORT);
  const isComponent =
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value);
  expect(isComponent, `apps/h5/src/components/base/index.ts exports ${IMAGE_EXPORT}`).toBe(true);
  return value as ComponentType<AsyncImageProps>;
}

/** The image frame holding `img`. */
export function frameOf(img: Element): HTMLElement {
  const frame = img.closest<HTMLElement>(FRAME);
  expect(frame, `${FRAME} around the img`).not.toBeNull();
  return frame!;
}

/** The only image frame inside `root`. */
export function onlyFrame(root: ParentNode): HTMLElement {
  const frames = root.querySelectorAll<HTMLElement>(FRAME);
  expect(frames.length, `one ${FRAME}`).toBe(1);
  return frames[0]!;
}

export function stateOf(frame: Element): string | null {
  return frame.getAttribute('data-state');
}

/** Imgs in `frame` that may still be painted (not removed, no `hidden` attribute). */
export function shownImgs(frame: Element): HTMLImageElement[] {
  return Array.from(frame.querySelectorAll('img')).filter((img) => !img.hasAttribute('hidden'));
}

/** True when `element` and its ancestors up to `root` are neither aria-hidden nor hidden. */
export function readable(element: Element, root: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden')) return false;
    if (node === root) break;
  }
  return true;
}

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
