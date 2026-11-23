// F1-07ec: a text with a copy button. A text longer than `maxLength` characters keeps its head and
// tail and elides the middle with 「…」; the full text is the element's title (shown on hover) and
// is what the button copies. The result of the copy shows next to the button for a moment.
import { CopyOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';
import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import { componentsTexts } from '../../texts/components.ts';

export interface CopyTextProps {
  readonly text: string;
  readonly maxLength?: number;
}

const t = componentsTexts.copyText;
const ELLIPSIS = '…';
const DEFAULT_MAX_LENGTH = 24;
/** The shortest limit that still leaves one character on each side of the ellipsis. */
const MIN_MAX_LENGTH = 3;
const FEEDBACK_MS = 2000;

/** `text` itself when it fits, else head + 「…」 + tail, at most `maxLength` characters. */
export function middleEllipsis(text: string, maxLength: number): string {
  const chars = Array.from(text);
  const limit = Math.max(MIN_MAX_LENGTH, Math.trunc(maxLength));
  if (chars.length <= limit) return text;
  const kept = limit - 1;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return `${chars.slice(0, head).join('')}${ELLIPSIS}${chars.slice(chars.length - tail).join('')}`;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyText({ text, maxLength = DEFAULT_MAX_LENGTH }: CopyTextProps): ReactElement {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const show = (next: CopyState): void => {
    if (!mounted.current) return;
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (mounted.current) setState('idle');
    }, FEEDBACK_MS);
  };

  const copy = (event: MouseEvent<HTMLElement>): void => {
    // A copy inside a clickable row or cell must not also trigger the row's action.
    event.stopPropagation();
    let written: Promise<void>;
    try {
      written = navigator.clipboard.writeText(text);
    } catch {
      show('failed');
      return;
    }
    written.then(
      () => show('copied'),
      () => show('failed'),
    );
  };

  const visible = middleEllipsis(text, maxLength);
  return (
    <span>
      <span title={visible === text ? undefined : text}>{visible}</span>
      <Button type="text" size="small" aria-label={t.copy} icon={<CopyOutlined />} onClick={copy} />
      <span aria-live="polite">
        {state === 'copied' ? <Typography.Text type="success">{t.copied}</Typography.Text> : null}
        {state === 'failed' ? <Typography.Text type="danger">{t.failed}</Typography.Text> : null}
      </span>
    </span>
  );
}
