// 【红冲】对话框（adminCreateAdjustment 红冲形状，fund.adjust，一步提交并生效）：原单摘要与新单预览只读——
// 红冲方向一律取原单方向的相反、红冲金额等于原单（整笔，不支持部分红冲）；红冲前 / 后可用余额按
// adminGetAdjustment 的 balance_preview（打开时重新读取，经 @couli/money，为负照实显示负数）。唯一的输入是
// 红冲原因；请求体只有 reverses_adjust_id 与去空白的 note。20902（已被别人红冲）交回页面刷新。
// 结果未知（没拿到带统一外壳的回答）时红冲原因锁定、不能关闭，只有【重试】（原键原请求体）与【去列表核对】。
import { Alert, Button, Descriptions, Flex, Form, Input, Modal, theme } from 'antd';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { plannedButtonProps } from '../../components/planned/index.ts';
import type { MarkerClock } from '../../components/unknown-marker/index.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import {
  adjustmentUrl,
  directionLabel,
  money,
  reasonLabel,
  type Adjustment,
  type AdjustmentDetail,
} from './model.ts';
import { useAdjustmentWrite } from './useAdjustmentWrite.tsx';
import { useRead } from './useRead.ts';
import {
  alreadyReversed,
  feedback,
  oppositeOf,
  reverseNoteError,
  writeErrorText,
  type Executed,
} from './write.ts';

const w = adjustmentsTexts.write;
const r = w.reverse;
const s = r.summary;

export interface ReverseDialogProps {
  /** The original form (APPROVED, not a reversal, not reversed). */
  readonly item: Adjustment;
  readonly planned: boolean;
  /** The page's injected clock: the moment of the result-unknown marker (F1-08at). */
  readonly clock: MarkerClock;
  readonly onClose: () => void;
  readonly onReversed: (executed: Executed) => void;
  /** 20902: the original was reversed meanwhile (the page refreshes and says so). */
  readonly onStale: () => void;
  /** 【去列表核对】 while the result is unknown: close and read the list again. */
  readonly onCheck: () => void;
}

export function ReverseDialog({
  item,
  planned,
  onClose,
  onReversed,
  onStale,
  onCheck,
  clock,
}: ReverseDialogProps): ReactElement {
  const { token } = theme.useToken();
  const ids = { note: useId(), phone: useId() };
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const [writeError, setWriteError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const detail = useRead<AdjustmentDetail>(adjustmentUrl(item.adjust_id), undefined, attempt);

  const write = useAdjustmentWrite({
    operation: w.reverseOperation,
    clock,
    onDone: onReversed,
    onFailed: (cause) => {
      if (alreadyReversed(cause)) onStale();
      else setWriteError(writeErrorText(cause));
    },
  });

  /** The result of the last submission is unknown: nothing can be changed. */
  const locked = write.unknown;
  const noteError = checked ? reverseNoteError(note) : undefined;

  const submit = () => {
    if (write.busy || write.phoneMissing || locked || planned) return;
    setChecked(true);
    if (reverseNoteError(note) !== undefined) return;
    setWriteError(undefined);
    write.submit({ reverses_adjust_id: item.adjust_id, note: note.trim() });
  };
  const close = () => {
    if (write.busy || locked) return;
    onClose();
  };
  const retry = () => {
    if (write.busy || !locked) return;
    setWriteError(undefined);
    write.retry();
  };
  const check = () => {
    if (write.busy || !locked) return;
    onCheck();
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { fontVariantNumeric: 'tabular-nums' } as const;

  let before: ReactNode;
  let after: ReactNode;
  if (detail.status === 'ready') {
    const preview = detail.data.balance_preview;
    before = preview === null ? adjustmentsTexts.dash : money(preview.available_before_fen);
    after = preview === null ? adjustmentsTexts.dash : money(preview.available_after_fen);
  } else if (detail.status === 'failed') {
    before = (
      <Flex align="center" gap={8}>
        {r.balanceFailed}
        <Button size="small" onClick={() => setAttempt((value) => value + 1)}>
          {adjustmentsTexts.retry}
        </Button>
      </Flex>
    );
    after = adjustmentsTexts.dash;
  } else {
    before = r.balanceLoading;
    after = r.balanceLoading;
  }

  const footer = locked
    ? [
        <Button key="check" autoInsertSpace={false} disabled={write.busy} onClick={check}>
          {w.check}
        </Button>,
        <Button
          key="retry"
          type="primary"
          autoInsertSpace={false}
          disabled={write.busy}
          onClick={retry}
        >
          {w.retry}
        </Button>,
      ]
    : [
        <Button key="cancel" autoInsertSpace={false} disabled={write.busy} onClick={close}>
          {w.cancel}
        </Button>,
        <Button
          key="submit"
          type="primary"
          autoInsertSpace={false}
          disabled={write.busy}
          aria-disabled={write.phoneMissing ? true : undefined}
          aria-describedby={write.phoneMissing ? ids.phone : undefined}
          {...plannedButtonProps(planned)}
          onClick={submit}
        >
          {w.submit}
        </Button>,
      ];

  return (
    <Modal
      open
      width={560}
      title={r.title}
      maskClosable={false}
      keyboard={!write.busy && !locked}
      closable={!locked}
      destroyOnHidden
      footer={footer}
      onCancel={close}
    >
      <Flex vertical gap={16}>
        <Alert type="info" showIcon role="note" message={r.notice} />
        <Descriptions
          bordered
          size="small"
          column={1}
          items={[
            { key: 'id', label: s.id, children: <span style={code}>{item.adjust_id}</span> },
            { key: 'user', label: s.user, children: <span style={code}>{item.user_id}</span> },
            { key: 'direction', label: s.direction, children: directionLabel(item.direction) },
            {
              key: 'amount',
              label: s.amount,
              children: <span style={amount}>{money(item.amount_fen)}</span>,
            },
            { key: 'reason', label: s.reason, children: reasonLabel(item.reason_code) },
            {
              key: 'newDirection',
              label: s.newDirection,
              children: directionLabel(oppositeOf(item.direction)),
            },
            {
              key: 'newAmount',
              label: s.newAmount,
              children: <span style={amount}>{money(item.amount_fen)}</span>,
            },
            { key: 'before', label: s.before, children: <span style={amount}>{before}</span> },
            { key: 'after', label: s.after, children: <span style={amount}>{after}</span> },
          ]}
        />
        <Form layout="vertical" component="div">
          <Form.Item
            label={r.noteLabel}
            htmlFor={ids.note}
            {...feedback(noteError)}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={ids.note}
              value={note}
              disabled={locked}
              autoSize={{ minRows: 3, maxRows: 6 }}
              onChange={(event) => setNote(event.target.value)}
            />
          </Form.Item>
        </Form>
        {write.phoneMissing ? (
          <div id={ids.phone}>
            <Alert type="warning" showIcon message={stepUpTexts.verifyPhoneMissing} />
          </div>
        ) : null}
        {locked ? <Alert type="warning" showIcon message={w.unknown} /> : null}
        {writeError === undefined ? null : <Alert type="error" showIcon message={writeError} />}
      </Flex>
      {write.stepUp}
    </Modal>
  );
}
