// Dialogs of the order detail writes (F1-07ee). Each one is mounted only while open (unmounted on
// close, nothing kept between openings) and sends through useOrderWrite: the body carries the
// row_version of the shown detail (expected_row_version), or, for 【指定归属】, what the operator
// saw of the attribution (expected_user_id null, expected_locked = flags.locked). While a result
// is unknown the dialog cannot be closed (no 【取消】, close button or Esc) and its inputs stay
// locked. Nothing of a body is kept once the dialog is unmounted (no form is ever restored); while
// the shown detail has a status this console does not know (`suspended`, BR-TEXT-05) the dialog
// stays mounted with its inputs but shows nothing and sends nothing: only the page's
// result-unknown prompt is visible, and the dialog comes back with the same body and value only
// after a reread shows known statuses again. Notes and reasons are checked and sent after
// trimming (sentText).
import { Alert, Button, Flex, Form, Input, Modal, Radio, Typography } from 'antd';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import type { MarkerClock } from '../../../components/unknown-marker/index.ts';
import type { AccessControl } from '../../../providers/access-control/index.ts';
import { codePointLength } from '../../../text-length.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import { codeLabel, type OrderDetail } from '../model.ts';
import {
  ASSIGN_REASON_LIMIT,
  NONE,
  NOTE_LIMIT,
  STAFF_HOLD_REASONS,
  USER_ID,
  assignReasonValid,
  derivedHoldReason,
  dialogClosable,
  noteValid,
  sentText,
  subReasonLabel,
  subReasonsOf,
  writeUrl,
  type AssignBody,
  type HoldBody,
  type ReasonSubChoice,
  type ReasonSubBody,
  type StaffHoldReason,
  type UnholdBody,
} from './model.ts';
import { useOrderWrite, type OrderWrite, type WriteDone } from './useOrderWrite.tsx';

const w = ordersTexts.writes;

export interface DialogProps {
  readonly order: OrderDetail;
  readonly onDone: (done: WriteDone) => void;
  /** Closed by the operator (only while editing; never while a result is unknown). */
  readonly onClose: () => void;
  /** The console clock of the result-unknown marker. */
  readonly clock: MarkerClock;
  /** The shown detail has a status this console does not know: show nothing, send nothing. */
  readonly suspended: boolean;
}

function WriteModal<B>(props: {
  readonly title: string;
  readonly submitText: string;
  readonly write: OrderWrite<B>;
  readonly suspended: boolean;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactElement | null {
  const { title, submitText, write, suspended, onSubmit, onClose, children } = props;
  if (suspended) return null;
  const closable = dialogClosable(write.phase);
  const close = () => {
    if (closable) onClose();
  };
  const footer = (
    <Flex justify="flex-end" gap={8} wrap>
      <Button disabled={!closable} onClick={close}>
        {w.cancel}
      </Button>
      {write.phase === 'unknown' ? (
        <Button type="primary" onClick={write.retry}>
          {w.retry}
        </Button>
      ) : null}
      <Button
        type={write.phase === 'unknown' ? 'default' : 'primary'}
        disabled={write.locked}
        loading={write.phase === 'sending'}
        onClick={onSubmit}
      >
        {submitText}
      </Button>
    </Flex>
  );
  // While the 动态码 dialog is open this dialog is taken down (its inputs live in the caller's
  // state and come back unchanged): one dialog at a time, so the accessible name and the focus
  // belong to the 动态码 dialog only (same as the unions / risk-state pages).
  if (write.stepUpModal !== null) return write.stepUpModal;
  return (
    <Modal
      open
      title={title}
      footer={footer}
      closable={closable}
      maskClosable={false}
      keyboard={closable}
      onCancel={close}
    >
      <Flex vertical gap={12}>
        {write.phase === 'unknown' ? (
          <Alert type="warning" showIcon message={w.result.unknown} />
        ) : null}
        {write.error === undefined ? null : <Alert type="error" showIcon message={write.error} />}
        <Form layout="vertical" component="div">
          {children}
        </Form>
      </Flex>
    </Modal>
  );
}

function NoteField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly locked: boolean;
  readonly invalid: boolean;
}): ReactElement {
  const id = useId();
  const h = w.hold;
  return (
    <Form.Item
      label={h.note}
      htmlFor={id}
      required
      validateStatus={props.invalid ? 'error' : ''}
      help={props.invalid ? h.noteRequired : undefined}
    >
      <Input.TextArea
        id={id}
        value={props.value}
        disabled={props.locked}
        placeholder={h.notePlaceholder}
        autoSize={{ minRows: 3, maxRows: 6 }}
        count={{ show: true, max: NOTE_LIMIT, strategy: codePointLength }}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Form.Item>
  );
}

/** 【暂停结算】 / 【恢复结算】: reason (derived from the points for a hold when it can be) and note. */
export function HoldDialog(
  props: DialogProps & {
    readonly mode: 'hold' | 'unhold';
    readonly access: AccessControl;
  },
): ReactElement | null {
  const { order, mode, access, onDone, onClose, clock, suspended } = props;
  const h = w.hold;
  const title = mode === 'hold' ? w.entries.hold : w.entries.unhold;
  const derived = mode === 'hold' ? derivedHoldReason(access) : undefined;
  const [reason, setReason] = useState<StaffHoldReason>();
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const write = useOrderWrite<HoldBody | UnholdBody>({
    url: writeUrl(order, mode),
    operation: title,
    onDone,
    orderId: order.order_id,
    clock,
    blocked: suspended,
  });
  const chosen = derived ?? reason;
  const noteOk = noteValid(note);

  const submit = () => {
    setTried(true);
    if (chosen === undefined || !noteOk) return;
    write.submit({
      reason_code: chosen,
      note: sentText(note),
      expected_row_version: order.row_version,
    });
  };

  return (
    <WriteModal
      title={title}
      submitText={mode === 'hold' ? w.submit.hold : w.submit.unhold}
      write={write}
      suspended={suspended}
      onSubmit={submit}
      onClose={onClose}
    >
      <Typography.Paragraph type="secondary">
        {mode === 'hold' ? h.holdIntro : h.unholdIntro}
      </Typography.Paragraph>
      {derived === undefined ? (
        <Form.Item
          label={mode === 'hold' ? h.holdReason : h.unholdReason}
          required
          validateStatus={tried && reason === undefined ? 'error' : ''}
          help={tried && reason === undefined ? h.reasonRequired : undefined}
        >
          <Radio.Group
            value={reason}
            disabled={write.locked}
            options={STAFF_HOLD_REASONS.map((code) => ({
              value: code,
              label: codeLabel('hold_reason', code),
            }))}
            onChange={(event) => setReason(event.target.value as StaffHoldReason)}
          />
        </Form.Item>
      ) : (
        <Form.Item label={h.holdReason}>
          <Typography.Text>{h.derived(codeLabel('hold_reason', derived))}</Typography.Text>
        </Form.Item>
      )}
      <NoteField value={note} onChange={setNote} locked={write.locked} invalid={tried && !noteOk} />
    </WriteModal>
  );
}

/** 【原因细分】: one sub-reason of the order's reason (the contract groups) or 「无」 (none). */
export function ReasonSubDialog(props: DialogProps): ReactElement | null {
  const { order, onDone, onClose, clock, suspended } = props;
  const s = w.reasonSub;
  const subs = subReasonsOf(order.reason);
  const current = order.reason_sub ?? null;
  const [value, setValue] = useState<ReasonSubChoice | undefined>(() =>
    current === null ? NONE : subs.find((sub) => sub === current),
  );
  const [tried, setTried] = useState(false);
  const write = useOrderWrite<ReasonSubBody>({
    url: writeUrl(order, 'reason-sub'),
    operation: w.entries.reasonSub,
    onDone,
    orderId: order.order_id,
    clock,
    blocked: suspended,
  });

  const submit = () => {
    setTried(true);
    if (value === undefined) return;
    write.submit({ reason_sub: value, expected_row_version: order.row_version });
  };

  return (
    <WriteModal
      title={w.entries.reasonSub}
      submitText={w.submit.reasonSub}
      write={write}
      suspended={suspended}
      onSubmit={submit}
      onClose={onClose}
    >
      <Typography.Paragraph type="secondary">{s.intro}</Typography.Paragraph>
      <Typography.Text>{s.current(order.reason ?? ordersTexts.dash)}</Typography.Text>
      <Form.Item
        label={s.field}
        required
        validateStatus={tried && value === undefined ? 'error' : ''}
        help={tried && value === undefined ? w.hold.reasonRequired : undefined}
      >
        <Radio.Group
          value={value}
          disabled={write.locked}
          options={[
            ...subs.map((sub) => ({ value: sub, label: subReasonLabel(sub) })),
            { value: NONE, label: s.none },
          ]}
          onChange={(event) => setValue(event.target.value as ReasonSubChoice)}
        />
      </Form.Item>
    </WriteModal>
  );
}

/** 【指定归属】 of an unattributed order: target UID and reason; totp step-up only on 10003. */
export function AssignDialog(props: DialogProps): ReactElement | null {
  const { order, onDone, onClose, clock, suspended } = props;
  const a = w.assign;
  const userId = useId();
  const reasonId = useId();
  const [user, setUser] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const write = useOrderWrite<AssignBody>({
    url: writeUrl(order, 'reassign'),
    operation: a.stepUpOperation,
    onDone,
    orderId: order.order_id,
    clock,
    blocked: suspended,
  });
  const userValid = USER_ID.test(user.trim());
  const reasonValid = assignReasonValid(reason);

  const submit = () => {
    setTried(true);
    if (!userValid || !reasonValid) return;
    write.submit({
      user_id: user.trim(),
      expected_user_id: null,
      expected_locked: order.flags.locked,
      reason: sentText(reason),
    });
  };

  return (
    <WriteModal
      title={w.entries.assign}
      submitText={w.submit.assign}
      write={write}
      suspended={suspended}
      onSubmit={submit}
      onClose={onClose}
    >
      <Typography.Paragraph type="secondary">{a.intro}</Typography.Paragraph>
      <Form.Item
        label={a.user}
        htmlFor={userId}
        required
        validateStatus={tried && !userValid ? 'error' : ''}
        help={tried && !userValid ? a.userInvalid : undefined}
      >
        <Input
          id={userId}
          value={user}
          disabled={write.locked}
          placeholder={a.userPlaceholder}
          autoComplete="off"
          onChange={(event) => setUser(event.target.value)}
        />
      </Form.Item>
      <Form.Item
        label={a.reason}
        htmlFor={reasonId}
        required
        validateStatus={tried && !reasonValid ? 'error' : ''}
        help={tried && !reasonValid ? a.reasonInvalid : undefined}
      >
        <Input.TextArea
          id={reasonId}
          value={reason}
          disabled={write.locked}
          placeholder={a.reasonPlaceholder}
          autoSize={{ minRows: 3, maxRows: 6 }}
          count={{ show: true, max: ASSIGN_REASON_LIMIT, strategy: codePointLength }}
          onChange={(event) => setReason(event.target.value)}
        />
      </Form.Item>
    </WriteModal>
  );
}
