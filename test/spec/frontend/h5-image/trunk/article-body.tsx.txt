import { useMemo, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { renderJSONContentToReactElement } from '@tiptap/static-renderer/json/react';
import { call, has } from '@couli/bridge-sdk';
import { rulesTexts } from '../../texts/rules.ts';
import {
  normalizeOrigins,
  safeHttpsUrl,
  sanitizeArticleBody,
  type ArticleMark,
  type ArticleNode,
} from './sanitize.ts';

export interface ArticleBodyProps {
  /** Article.body: the serialized tiptap / ProseMirror document JSON. */
  body: string;
  /**
   * The media CDN origin images may come from (scheme, host and port compared exactly). Absent or
   * empty, no image is rendered at all.
   */
  mediaCdnOrigin?: string;
  /**
   * Allowed media origins from deployment configuration (VITE_MEDIA_ORIGINS); used when no
   * `mediaCdnOrigin` is given. Only https origins are honoured.
   */
  mediaOrigins?: readonly string[];
}

interface NodeProps {
  node: ArticleNode;
  parent?: ArticleNode | undefined;
  children?: ReactNode;
}

interface MarkProps {
  mark: ArticleMark;
  children?: ReactNode;
}

const TEXT = 'text-couli-body leading-couli-body text-couli-text-primary';
const HEADING = 'font-couli-semibold text-couli-text-primary';
const HEADINGS = {
  1: `text-couli-title leading-couli-title ${HEADING}`,
  2: `text-couli-body leading-couli-body ${HEADING}`,
  3: `text-couli-footnote leading-couli-footnote ${HEADING}`,
} as const;
const LIST = 'flex flex-col gap-couli-2';
const LIST_ITEM = 'flex items-start gap-couli-3';
/** Ordered list number badge (design: 24px muted circle, 12/600 number) from a CSS counter. */
const ORDERED_ITEM = `${LIST_ITEM} [counter-increment:article-item] before:flex before:size-6 before:flex-none before:items-center before:justify-center before:rounded-couli-pill before:bg-couli-background-muted before:text-couli-caption before:leading-couli-caption before:font-couli-semibold before:text-couli-text-primary before:content-[counter(article-item)]`;
/** Bullet dot centred on the first text line. */
const BULLET_ITEM = `${LIST_ITEM} before:mt-[0.6em] before:size-1.5 before:flex-none before:rounded-couli-pill before:bg-couli-text-secondary before:content-['']`;

/** Opens an https link through the App (ext.openBrowser); never navigates the WebView itself. */
function openExternal(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  event.preventDefault();
  const capability = has('ext.openBrowser');
  if (capability === null) return;
  call(capability, { url: href }).catch(() => undefined);
}

function Link({ mark, children }: MarkProps): ReactNode {
  if (mark.type !== 'link') return children;
  const href = safeHttpsUrl(mark.attrs.href);
  if (href === null) return children;
  return (
    <a
      href={href}
      rel="noopener noreferrer"
      className="text-couli-text-link underline underline-offset-2"
      onClick={(event) => openExternal(event, href)}
    >
      {children}
    </a>
  );
}

function Heading({ node, children }: NodeProps): ReactNode {
  const level = node.attrs?.['level'];
  if (level === 1) return <h1 className={HEADINGS[1]}>{children}</h1>;
  if (level === 2) return <h2 className={HEADINGS[2]}>{children}</h2>;
  if (level === 3) return <h3 className={HEADINGS[3]}>{children}</h3>;
  return null;
}

function Image({ node }: NodeProps): ReactNode {
  const src = node.attrs?.['src'];
  const alt = node.attrs?.['alt'];
  if (typeof src !== 'string' || src === '') return null;
  return (
    <img
      src={src}
      alt={typeof alt === 'string' ? alt : ''}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="block h-auto max-w-full rounded-couli-small"
    />
  );
}

const nodeMapping = {
  doc: ({ children }: NodeProps) => <>{children}</>,
  text: ({ node }: NodeProps) => node.text ?? '',
  paragraph: ({ children }: NodeProps) => <p className={TEXT}>{children}</p>,
  heading: Heading,
  blockquote: ({ children }: NodeProps) => (
    <blockquote className="flex flex-col gap-couli-2 rounded-couli-button bg-couli-background-muted p-couli-3">
      {children}
    </blockquote>
  ),
  bulletList: ({ children }: NodeProps) => <ul className={LIST}>{children}</ul>,
  orderedList: ({ children }: NodeProps) => (
    <ol className={`${LIST} [counter-reset:article-item]`}>{children}</ol>
  ),
  listItem: ({ parent, children }: NodeProps) => (
    <li className={parent?.type === 'orderedList' ? ORDERED_ITEM : BULLET_ITEM}>
      <div className="flex min-w-0 flex-1 flex-col gap-couli-2">{children}</div>
    </li>
  ),
  horizontalRule: () => <hr className="border-0 border-t border-couli-border-subtle" />,
  hardBreak: () => <br />,
  image: Image,
};

const markMapping = {
  bold: ({ children }: MarkProps) => <strong className="font-couli-semibold">{children}</strong>,
  italic: ({ children }: MarkProps) => <em>{children}</em>,
  link: Link,
};

/** Anything that slipped past the whitelist pass renders nothing. */
function Unhandled(): null {
  return null;
}

function renderBody(body: string, origins: readonly string[]): ReactNode | null {
  const content = sanitizeArticleBody(body, normalizeOrigins(origins));
  if (content === null) return null;
  try {
    // Static renderer over plain JSON (no editor schema, no ProseMirror): node and mark types map
    // to the components above only. A fresh renderer per body keeps its element keys small.
    const render = renderJSONContentToReactElement<ArticleMark, ArticleNode>({
      nodeMapping,
      markMapping,
      unhandledNode: Unhandled,
      unhandledMark: Unhandled,
    });
    return render({ content });
  } catch {
    return null;
  }
}

/**
 * Article body (F1-03a): the stored tiptap JSON goes through the whitelist pass, then through
 * `@tiptap/static-renderer` straight to React elements — never through an HTML string. A body that
 * is not a document shows an error line in place of the text and never throws.
 */
export function ArticleBody({
  body,
  mediaCdnOrigin,
  mediaOrigins,
}: ArticleBodyProps): ReactElement {
  // An explicit origin wins (an empty one allows none); then the configured list; else none.
  const origins = mediaCdnOrigin !== undefined ? [mediaCdnOrigin] : (mediaOrigins ?? []);
  const originsKey = origins.join(' ');
  const rendered = useMemo(
    () => renderBody(body, originsKey === '' ? [] : originsKey.split(' ')),
    [body, originsKey],
  );
  if (rendered === null) {
    return (
      <div
        role="alert"
        className="text-couli-footnote leading-couli-footnote text-couli-text-secondary"
      >
        {rulesTexts.bodyFailed}
      </div>
    );
  }
  return <div className="flex flex-col gap-couli-4 break-words">{rendered}</div>;
}
