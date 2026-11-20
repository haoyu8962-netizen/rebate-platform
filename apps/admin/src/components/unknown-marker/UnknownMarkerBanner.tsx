// F1-08at (FU-ADMIN-UNKNOWN-ON-RELOGIN, D10-2075): the prompt at the top of a page whose marker
// (./marker.ts) is kept: the fixed notice with the moment the result became unknown (Beijing
// time, YYYY-MM-DD HH:mm:ss) and one real button 「关闭」 that removes the prompt and the marker.
// No automatic retry, no restored form; no element handles clicks or keys without an interactive
// role (D10-2050). It shows the marker found when the page opens (e.g. after signing in again);
// a submission of this very page that becomes unknown is shown by its own dialog, not here. The
// marker going away (closed here, or the unknown result settled) removes the prompt.
import { Alert, Button } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import {
  clearUnknown,
  readUnknown,
  subscribeMarkers,
  type MarkerScope,
  type UnknownMarker,
} from './marker.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';

export interface UnknownMarkerBannerProps {
  /** The page and the signed-in account whose marker is shown. */
  readonly scope: MarkerScope;
}

const t = withdrawalsTexts.unknownMarker;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const two = (value: number): string => String(value).padStart(2, '0');

/** YYYY-MM-DD HH:mm:ss in Beijing time (+08:00), never the runtime's own time zone. */
export function beijingMoment(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return (
    `${String(d.getUTCFullYear())}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
  );
}

export function UnknownMarkerBanner({ scope }: UnknownMarkerBannerProps): ReactElement | null {
  const { page, account } = scope;
  /** The marker found for this page and account when they were last seen (read once per pair). */
  const [shown, setShown] = useState<{
    readonly page: string;
    readonly account: string | undefined;
    readonly marker: UnknownMarker | undefined;
  }>(() => ({ page, account, marker: readUnknown({ page, account }) }));
  // The page opens, or the signed-in account becomes known or changes: read again.
  if (shown.page !== page || shown.account !== account)
    setShown({ page, account, marker: readUnknown({ page, account }) });
  const marker = shown.page === page && shown.account === account ? shown.marker : undefined;

  // Gone from the storage (closed, or settled by a write of this page): the prompt goes too.
  useEffect(
    () =>
      subscribeMarkers(() => {
        if (readUnknown({ page, account }) !== undefined) return;
        setShown((previous) =>
          previous.page === page && previous.account === account && previous.marker !== undefined
            ? { page, account, marker: undefined }
            : previous,
        );
      }),
    [page, account],
  );

  if (marker === undefined || account === undefined) return null;
  const close = () => {
    clearUnknown({ page, account });
    setShown({ page, account, marker: undefined });
  };
  return (
    <Alert
      type="warning"
      showIcon
      message={t.notice}
      description={t.moment(beijingMoment(marker.at))}
      action={
        <Button size="small" autoInsertSpace={false} onClick={close}>
          {t.close}
        </Button>
      }
    />
  );
}
