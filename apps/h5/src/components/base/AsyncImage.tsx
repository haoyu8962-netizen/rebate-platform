import {
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributeReferrerPolicy,
  type ReactElement,
} from 'react';
import { t } from '../../shared/texts.ts';

export interface AsyncImageProps {
  /** null / undefined / '' is the no-image state: an empty placeholder frame, no request. */
  src: string | null | undefined;
  /** The img's alternative text and accessible name ('' for a decorative image). */
  alt: string;
  /** CSS aspect-ratio the frame keeps in every state, e.g. '3 / 2'. */
  aspectRatio?: string;
  /** Passed to the img only when given (article images use 'no-referrer'). */
  referrerPolicy?: HTMLAttributeReferrerPolicy;
  /** Failure text; defaults to the dictionary text of state.load_failed.title. */
  failedText?: string;
  /** Extra layout classes for the frame. */
  className?: string;
  /** Called with the url when it fails to load (the frame shows the error state). */
  onError?: (url: string) => void;
}

type Settled = 'loaded' | 'error';

const FRAME = 'relative block w-full overflow-hidden';
const PLACEHOLDER = 'bg-couli-background-placeholder';
/** Opacity fade on --motion-duration-normal / --motion-easing-enter (shared/styles/index.css). */
const FADE = 'h5-image-fade';
const FAILED_TEXT =
  'flex items-center justify-center px-couli-3 py-couli-4 text-center text-couli-footnote leading-couli-footnote text-couli-text-secondary break-words';

function joined(...parts: (string | false | undefined)[]): string {
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}

/**
 * Image with four states on `data-state` of its `data-slot="image-frame"` frame (design/ui-rules
 * §3.6): loading (placeholder colour, the img already requested but transparent), loaded (the img
 * fades in; no fade under reduced motion), error (placeholder plus a readable failure text, no
 * broken-image icon) and empty (no src: the placeholder frame only). With `aspectRatio` the frame
 * keeps that ratio in every state and the img covers it; without it the img sets the height once
 * loaded. A new `src` starts again at loading, including a return to a url that failed before.
 */
export function AsyncImage({
  src,
  alt,
  aspectRatio,
  referrerPolicy,
  failedText,
  className,
  onError,
}: AsyncImageProps): ReactElement {
  const url = typeof src === 'string' && src !== '' ? src : null;
  const [settled, setSettled] = useState<{ url: string; state: Settled } | null>(null);
  // A new url drops the last result, so going back to an earlier url (A → B → A) loads it again
  // even when B never settled, instead of reusing A's old failure.
  const [shown, setShown] = useState(url);
  if (shown !== url) {
    setShown(url);
    setSettled(null);
  }
  const imgRef = useRef<HTMLImageElement>(null);
  const state =
    url === null ? 'empty' : settled !== null && settled.url === url ? settled.state : 'loading';

  // An image already in the cache is complete before React sees its load event: show it at once.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (url === null || img === null) return;
    if (img.complete && img.naturalWidth > 0) setSettled({ url, state: 'loaded' });
  }, [url]);

  const ratio = aspectRatio !== undefined && aspectRatio !== '';
  const loaded = state === 'loaded';
  const frameClass = joined(
    FRAME,
    (ratio || !loaded) && PLACEHOLDER,
    !ratio && !loaded && state !== 'error' && 'min-h-couli-12',
    className,
  );

  return (
    <span
      data-slot="image-frame"
      data-state={state}
      className={frameClass}
      style={ratio ? { aspectRatio } : undefined}
    >
      {url !== null && state !== 'error' ? (
        <img
          key={url}
          ref={imgRef}
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          {...(referrerPolicy === undefined ? {} : { referrerPolicy })}
          className={joined(
            ratio ? 'absolute inset-0 size-full object-cover' : 'block h-auto max-w-full',
            FADE,
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setSettled({ url, state: 'loaded' })}
          onError={() => {
            setSettled({ url, state: 'error' });
            onError?.(url);
          }}
        />
      ) : null}
      {state === 'error' ? (
        <span className={joined(FAILED_TEXT, ratio && 'absolute inset-0')}>
          {failedText ?? t('state.load_failed.title')}
        </span>
      ) : null}
    </span>
  );
}
