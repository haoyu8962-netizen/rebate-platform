// 「批准坏账核销」对话框（待批准的核销候选单，fund.writeoff，BR-FUND-12）：只读的候选单摘要（当前可用余额与
// 冻结按列表读回的值，经 @couli/money）、「核销金额按批准时余额」说明与后果说明；列表说 approve_blocked 时
// 提示先处理提现单（只看 approve_blocked，不看冻结金额本身，也不自行拦截）。没有任何输入项。
// - 【批准核销】：短信档二次验证后只发一次 POST /admin/v1/bad-debt-writeoffs/{id}/approve，请求体恰为 {}
//   （金额由服务端按批准时可用余额取）；成功按返回状态（已核销 / 已取消）交回页面提示并刷新。
// - 20001 writeoff_frozen_pending：对话框里显示冻结提示、对话框保留；其余确定的失败照提示、保留。
// 写入经 useAdjustmentWrite（F1-08ce 的结果未知处理，编排 D10-1731），不另起一套：
// - 没拿到带统一外壳的回答（网络、无法解析）：进入结果未知，原键与原请求体（同一个 {} 对象）保留；对话框不能
//   关闭、【取消】换成【去列表核对】，再按【批准核销】即原样重试（重新短信验证）；之后遇 40901 / 5xx 仍结果未知，
//   拿到确定的回答才解除。
// - 带外壳的结果未定（5xx、40901）：沿用原 Idempotency-Key。
// - 以上结果未定都提示失败，并先重新读取候选单列表；读回前【批准核销】不可用，读回仍待批准才放开，已不是待批准
//   （或已不在）就交回页面提示并刷新、不再提交。20902 同样交回页面。任何失败都不自动重发。
import { Alert, Button, Descriptions, Flex, Modal, Typography, theme } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { plannedButtonProps } from '../../components/planned/index.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import { WRITEOFFS_URL, money, type Writeoff, type WriteoffPage } from './model.ts';
import { useAdjustmentWrite } from './useAdjustmentWrite.tsx';
import { useRead } from './useRead.ts';
import {
  frozenPending,
  outcomeUnknown,
  stateChanged,
  writeoffApproveUrl,
  writeoffErrorText,
  type ApproveRequest,
  type WriteoffApproved,
} from './write.ts';

const w = adjustmentsTexts.writeoffApprove;
const s = w.summary;
/** The approval body: always exactly {} (the same object on every resend). */
const APPROVE_BODY: ApproveRequest = {};

/** Largest page the contract allows: the member's candidates are read in one page. */
const CHECK_PAGE_SIZE = 200;

export interface WriteoffApproveDialogProps {
  /** The PENDING candidate (as the list last read it). */
  readonly item: Writeoff;
  /** adminApproveBadDebtWriteoff still planned: 【批准核销】 is greyed out. */
  readonly planned: boolean;
  /** 【取消】; `uncertain`: the approval may have been carried out (refresh). */
  readonly onClose: (uncertain: boolean) => void;
  readonly onApproved: (result: WriteoffApproved) => void;
  /** 20902, or the read after an unknown outcome found the candidate no longer PENDING. */
  readonly onStale: () => void;
  /** 【去列表核对】 while the approval's result is unknown: close and read the list again. */
  readonly onCheck: () => void;
}

export function WriteoffApproveDialog({
  item,
  planned,
  onClose,
  onApproved,
  onStale,
  onCheck,
}: WriteoffApproveDialogProps): ReactElement {
  const { token } = theme.useToken();
  const ids = { phone: useId() };
  const [writeError, setWriteError] = useState<string>();
  /** The last answer was writeoff_frozen_pending. */
  const [frozenRefused, setFrozenRefused] = useState(false);
  /** 0: no check yet; bumped after every unknown outcome (a new read of the list). */
  const [check, setCheck] = useState(0);
  /** An outcome was unknown: 【批准核销】 stays locked until a fresh read shows the candidate PENDING. */
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const staleSent = useRef(false);

  const reread = useRead<WriteoffPage>(
    check === 0 ? undefined : WRITEOFFS_URL,
    { user_id: item.user_id, page: 1, page_size: CHECK_PAGE_SIZE },
    check,
  );

  const stale = () => {
    if (staleSent.current) return;
    staleSent.current = true;
    onStale();
  };

  /** It may have been carried out: read the candidate again before anything is sent again. */
  const recheck = () => {
    setUncertain(true);
    setChecking(true);
    setCheck((value) => value + 1);
  };
  const failed = (cause: unknown) => {
    if (stateChanged(cause)) {
      stale();
      return;
    }
    if (frozenPending(cause)) {
      setFrozenRefused(true);
      return;
    }
    setWriteError(writeoffErrorText(cause));
    if (outcomeUnknown(cause)) recheck();
  };
  /** No reply in the unified envelope: the hook keeps the key and the body and locks. */
  const unknownOutcome = () => {
    setWriteError(adjustmentsTexts.write.errors.failed);
    recheck();
  };

  const approval = useAdjustmentWrite<ApproveRequest, WriteoffApproved>({
    operation: w.operation,
    url: writeoffApproveUrl(item.id),
    onDone: onApproved,
    onFailed: failed,
    onUnknown: unknownOutcome,
  });

  // useRead is ready only for the latest check: after an unknown outcome `fresh` is that read.
  const fresh =
    reread.status === 'ready' ? reread.data.items.find((row) => row.id === item.id) : undefined;
  const freshDone = reread.status === 'ready';
  const rechecking = checking && !(freshDone && fresh?.status === 'PENDING');
  useEffect(() => {
    if (!checking || !freshDone || fresh?.status === 'PENDING') return;
    if (staleSent.current) return;
    staleSent.current = true;
    onStale();
  }, [checking, freshDone, fresh, onStale]);

  const current = fresh?.status === 'PENDING' ? fresh : item;
  const locked = approval.busy || rechecking;
  /** The approval got no reply in the unified envelope: the dialog cannot be closed, only checked. */
  const unknown = approval.unknown;

  const approve = () => {
    if (locked || approval.phoneMissing || planned) return;
    setWriteError(undefined);
    setFrozenRefused(false);
    if (approval.unknown) approval.retry();
    else approval.submit(APPROVE_BODY);
  };

  const close = () => {
    if (approval.busy || unknown) return;
    onClose(uncertain);
  };
  const checkList = () => {
    if (approval.busy || !unknown) return;
    onCheck();
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { fontVariantNumeric: 'tabular-nums' } as const;

  const footer = [
    unknown ? (
      <Button key="check" autoInsertSpace={false} disabled={approval.busy} onClick={checkList}>
        {adjustmentsTexts.write.check}
      </Button>
    ) : (
      <Button key="cancel" autoInsertSpace={false} disabled={approval.busy} onClick={close}>
        {w.cancel}
      </Button>
    ),
    <Button
      key="approve"
      type="primary"
      danger
      autoInsertSpace={false}
      disabled={locked}
      aria-disabled={approval.phoneMissing ? true : undefined}
      aria-describedby={approval.phoneMissing ? ids.phone : undefined}
      {...plannedButtonProps(planned)}
      onClick={approve}
    >
      {w.approve}
    </Button>,
  ];

  return (
    <Modal
      open
      width={560}
      title={w.title}
      maskClosable={false}
      keyboard={!approval.busy && !unknown}
      closable={!unknown}
      destroyOnHidden
      footer={footer}
      onCancel={close}
    >
      <Flex vertical gap={16}>
        <Alert type="warning" showIcon role="note" message={w.consequence} />
        <Descriptions
          bordered
          size="small"
          column={1}
          items={[
            { key: 'id', label: s.id, children: <span style={code}>{current.id}</span> },
            { key: 'user', label: s.user, children: <span style={code}>{current.user_id}</span> },
            { key: 'since', label: s.since, children: current.negative_since },
            { key: 'days', label: s.days, children: String(current.negative_days) },
            {
              key: 'candidate',
              label: s.candidate,
              children: <span style={amount}>{money(current.candidate_fen)}</span>,
            },
            {
              key: 'available',
              label: s.available,
              children: <span style={amount}>{money(current.available_fen)}</span>,
            },
            {
              key: 'frozen',
              label: s.frozen,
              children: <span style={amount}>{money(current.frozen_fen)}</span>,
            },
          ]}
        />
        <Typography.Text type="secondary">{w.amountNotice}</Typography.Text>
        {current.approve_blocked || frozenRefused ? (
          <Alert type="error" showIcon message={w.frozenPending} />
        ) : null}
        {rechecking && reread.status === 'failed' ? (
          <Flex align="center" gap={8}>
            <Typography.Text type="danger">{w.checkFailed}</Typography.Text>
            <Button size="small" onClick={() => setCheck((value) => value + 1)}>
              {adjustmentsTexts.retry}
            </Button>
          </Flex>
        ) : null}
        {rechecking && reread.status !== 'failed' ? (
          <Typography.Text type="secondary" role="status">
            {w.checking}
          </Typography.Text>
        ) : null}
        {approval.phoneMissing ? (
          <div id={ids.phone}>
            <Alert type="warning" showIcon message={stepUpTexts.verifyPhoneMissing} />
          </div>
        ) : null}
        {unknown ? <Alert type="warning" showIcon message={w.unknown} /> : null}
        {writeError === undefined ? null : <Alert type="error" showIcon message={writeError} />}
      </Flex>
      {approval.stepUp}
    </Modal>
  );
}
