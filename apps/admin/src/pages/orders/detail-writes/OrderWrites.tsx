// Write entries of the full order detail page (F1-07ee), rendered in the page header: each
// entry only with its own permission point (none rendered, no request sent without it), none at
// all for an order with a status this console does not know (BR-TEXT-05). They are decided again
// from every detail the page shows (the reread after 20902 included).
// The result-unknown marker of the order (./useOrderMarker.ts, this account only, no body):
// - left by an earlier mount or before a reload: no entry is offered and UnknownWritePrompt shows
//   the moment. It never offers to close the prompt; it offers 【放弃这次提交】 only while the
//   detail read by this page is shown (not while it is read or after its read failed) and no write
//   of the order sent in this tab is still waiting for its answer. Giving up asks to confirm
//   (【确认放弃】 / 【继续等待】): it only stops waiting, the write may still take effect later.
//   No version is compared and nothing is taken as settled: a left marker counts as "no newer
//   detail" until it goes.
// - once a left marker goes (a definite answer of that request in this tab, or 【确认放弃】), the
//   page reads the detail once again and passes `locked` until that read is shown: no entry, and
//   an open dialog shows nothing and sends nothing (as with an unknown status). No form is
//   restored, nothing is resent automatically.
// - held by this page's own open dialog: the dialog stays as it is. If a detail shows a status
//   this console does not know, the dialog shows nothing and sends nothing (no 【重试】) while the
//   prompt says the result is unknown; once a reread shows known statuses the very same dialog,
//   body and values unchanged, comes back with its 【重试】.
import { CheckCircleOutlined, PauseCircleOutlined, UserAddOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Modal, Tooltip, Typography } from 'antd';
import { useState, type ReactElement } from 'react';
import {
  clearUnknown,
  readUnknown,
  type MarkerClock,
} from '../../../components/unknown-marker/index.ts';
import { beijingMoment } from '../../../components/unknown-marker/UnknownMarkerBanner.tsx';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import type { OrderDetail } from '../model.ts';
import {
  NO_ENTRIES,
  knownStatuses,
  writeEntriesOf,
  type WriteAction,
  type WriteEntries,
} from './model.ts';
import { writePending } from './openWrites.ts';
import type { OrderMarker } from './useOrderMarker.ts';
import type { WriteDone } from './useOrderWrite.tsx';
import { AssignDialog, HoldDialog, ReasonSubDialog } from './WriteDialogs.tsx';

const w = ordersTexts.writes;

const SAVED: Readonly<Record<WriteAction, string>> = {
  hold: w.result.held,
  unhold: w.result.unheld,
  'reason-sub': w.result.reasonSubSet,
  reassign: w.result.assigned,
};

export interface OrderWritesProps {
  readonly order: OrderDetail;
  readonly access: AccessControl;
  /** The order's result-unknown marker for the signed-in account (useOrderMarker). */
  readonly marker: OrderMarker;
  /** The console clock of the marker's moment. */
  readonly clock: MarkerClock;
  /** A write succeeded: show the detail of the response and the message. */
  readonly onSaved: (order: OrderDetail, message: string) => void;
  /** 20902: show the message and read the detail once again (nothing is resent). */
  readonly onConflict: (message: string) => void;
  /**
   * A left marker went and the detail read since then is not shown yet: `order` is not the
   * current detail, so no entry is offered and no dialog sends anything.
   */
  readonly locked: boolean;
}

export function OrderWrites(props: OrderWritesProps): ReactElement | null {
  const { order, access, marker, clock, onSaved, onConflict, locked } = props;
  const [chosen, setChosen] = useState<WriteAction>();
  const known = knownStatuses(order);
  // A marker left before this page opened, or the reread after it went still to be shown: no
  // new submission.
  const entries: WriteEntries =
    marker.left === undefined && !locked ? writeEntriesOf(order, access) : NO_ENTRIES;
  // A dialog with nothing sent (no marker) goes once the status is unknown or the page is locked;
  // one with a request open stays mounted, suspended, so its body comes back unchanged.
  if (chosen !== undefined && !known && marker.present === undefined) setChosen(undefined);
  if (chosen !== undefined && locked && marker.present === undefined) setChosen(undefined);
  const open = chosen;
  const suspended = !known || locked;

  const done = (action: WriteAction) => (result: WriteDone) => {
    setChosen(undefined);
    if (result.kind === 'saved' && result.order !== undefined) onSaved(result.order, SAVED[action]);
    else onConflict(w.result.conflict);
  };
  const close = () => setChosen(undefined);

  let dialog: ReactElement | null = null;
  if (open === 'hold' || open === 'unhold')
    dialog = (
      <HoldDialog
        mode={open}
        order={order}
        access={access}
        clock={clock}
        suspended={suspended}
        onDone={done(open)}
        onClose={close}
      />
    );
  else if (open === 'reason-sub')
    dialog = (
      <ReasonSubDialog
        order={order}
        clock={clock}
        suspended={suspended}
        onDone={done(open)}
        onClose={close}
      />
    );
  else if (open === 'reassign')
    dialog = (
      <AssignDialog
        order={order}
        clock={clock}
        suspended={suspended}
        onDone={done(open)}
        onClose={close}
      />
    );

  const unhold = entries.unholdBlocked ? (
    <Tooltip title={w.unholdBlocked}>
      <Button icon={<CheckCircleOutlined aria-hidden />} disabled>
        {w.entries.unhold}
      </Button>
    </Tooltip>
  ) : (
    <Button icon={<CheckCircleOutlined aria-hidden />} onClick={() => setChosen('unhold')}>
      {w.entries.unhold}
    </Button>
  );

  return (
    <>
      {entries.hold ? (
        <Button icon={<PauseCircleOutlined aria-hidden />} onClick={() => setChosen('hold')}>
          {w.entries.hold}
        </Button>
      ) : null}
      {entries.unhold ? unhold : null}
      {entries.reasonSub ? (
        <Button onClick={() => setChosen('reason-sub')}>{w.entries.reasonSub}</Button>
      ) : null}
      {entries.assign ? (
        <Button icon={<UserAddOutlined aria-hidden />} onClick={() => setChosen('reassign')}>
          {w.entries.assign}
        </Button>
      ) : null}
      {dialog}
    </>
  );
}

export interface UnknownWritePromptProps {
  /** The order's result-unknown marker for the signed-in account (useOrderMarker). */
  readonly marker: OrderMarker;
  /** The shown detail, or undefined while it is not (yet, or again) read. */
  readonly order: OrderDetail | undefined;
}

/**
 * The read-only prompt of an order write whose result is unknown: a marker left before this page
 * opened, or this page's own open write while the shown status is one this console does not know
 * (no 【重试】 then). For a left marker it offers 【放弃这次提交】 only while the page's own read
 * of the detail is shown and no write of the order is waiting for its answer in this tab; giving
 * up is confirmed first and drops the marker, after which the page reads the detail again. It has
 * no button that sends a write and none that closes the prompt.
 */
export function UnknownWritePrompt(props: UnknownWritePromptProps): ReactElement | null {
  const { marker, order } = props;
  const p = w.pendingPrompt;
  const [confirming, setConfirming] = useState(false);
  // The left marker went while asking (its request got an answer): the question goes with it.
  if (confirming && marker.left === undefined) setConfirming(false);
  const statusUnknown = order !== undefined && !knownStatuses(order);
  const shown = marker.left ?? (statusUnknown ? marker.present : undefined);
  if (shown === undefined || marker.scope.account === undefined) return null;
  const left = marker.left;
  const mayAbandon = left !== undefined && order !== undefined && !marker.sending;
  const reason = statusUnknown ? p.statusUnknown : marker.sending ? p.waiting : p.check;
  const lines = [p.moment(beijingMoment(shown.at)), reason];
  // Checked again at the click: the marker is still the left one and no write of it is open.
  const abandon = () => {
    setConfirming(false);
    if (left === undefined) return;
    if (readUnknown(marker.scope)?.at !== left.at || writePending(marker.orderId)) return;
    clearUnknown(marker.scope);
  };
  return (
    <>
      <Alert
        type="warning"
        showIcon
        message={p.notice}
        description={lines.join(' ')}
        action={
          mayAbandon ? (
            <Button size="small" danger autoInsertSpace={false} onClick={() => setConfirming(true)}>
              {p.abandon}
            </Button>
          ) : undefined
        }
      />
      <Modal
        open={confirming && left !== undefined}
        title={p.abandonTitle}
        destroyOnHidden
        maskClosable={false}
        onCancel={() => setConfirming(false)}
        footer={
          <Flex justify="end" gap={8}>
            <Button autoInsertSpace={false} onClick={() => setConfirming(false)}>
              {p.abandonCancel}
            </Button>
            <Button autoInsertSpace={false} type="primary" danger onClick={abandon}>
              {p.abandonOk}
            </Button>
          </Flex>
        }
      >
        <Typography.Paragraph>{p.abandonConfirm}</Typography.Paragraph>
      </Modal>
    </>
  );
}
