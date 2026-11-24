// Write entries of the full order detail page (F1-07ee), rendered in the page header: each
// entry only with its own permission point (none rendered, no request sent without it), none at
// all for an order with a status this console does not know (BR-TEXT-05). They are decided again
// from every detail the page shows (a reload after 20902 included), so nothing is remembered.
import { CheckCircleOutlined, PauseCircleOutlined, UserAddOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useState, type ReactElement } from 'react';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import type { OrderDetail } from '../model.ts';
import { writeEntriesOf, type WriteAction } from './model.ts';
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
  /** A write succeeded: show the detail of the response and the message. */
  readonly onSaved: (order: OrderDetail, message: string) => void;
  /** 20902: show the message and read the detail once again (nothing is resent). */
  readonly onConflict: (message: string) => void;
  /** Closed while a result was unknown: read the detail again to see what happened. */
  readonly onReload: () => void;
}

export function OrderWrites(props: OrderWritesProps): ReactElement | null {
  const { order, access, onSaved, onConflict, onReload } = props;
  const [open, setOpen] = useState<WriteAction>();
  const entries = writeEntriesOf(order, access);

  const done = (action: WriteAction) => (result: WriteDone) => {
    setOpen(undefined);
    if (result.kind === 'saved' && result.order !== undefined) onSaved(result.order, SAVED[action]);
    else onConflict(w.result.conflict);
  };
  const close = (unknown: boolean) => {
    setOpen(undefined);
    if (unknown) onReload();
  };

  let dialog: ReactElement | null = null;
  if (open === 'hold' || open === 'unhold')
    dialog = (
      <HoldDialog mode={open} order={order} access={access} onDone={done(open)} onClose={close} />
    );
  else if (open === 'reason-sub')
    dialog = <ReasonSubDialog order={order} onDone={done(open)} onClose={close} />;
  else if (open === 'reassign')
    dialog = <AssignDialog order={order} onDone={done(open)} onClose={close} />;

  const unhold = entries.unholdBlocked ? (
    <Tooltip title={w.unholdBlocked}>
      <Button icon={<CheckCircleOutlined aria-hidden />} disabled>
        {w.entries.unhold}
      </Button>
    </Tooltip>
  ) : (
    <Button icon={<CheckCircleOutlined aria-hidden />} onClick={() => setOpen('unhold')}>
      {w.entries.unhold}
    </Button>
  );

  return (
    <>
      {entries.hold ? (
        <Button icon={<PauseCircleOutlined aria-hidden />} onClick={() => setOpen('hold')}>
          {w.entries.hold}
        </Button>
      ) : null}
      {entries.unhold ? unhold : null}
      {entries.reasonSub ? (
        <Button onClick={() => setOpen('reason-sub')}>{w.entries.reasonSub}</Button>
      ) : null}
      {entries.assign ? (
        <Button icon={<UserAddOutlined aria-hidden />} onClick={() => setOpen('reassign')}>
          {w.entries.assign}
        </Button>
      ) : null}
      {dialog}
    </>
  );
}
