// 【启用】（只 pending 行）：花卷云忽略确认时间（北京时间，不晚于现在）、忽略截图（PNG / JPEG，
// 不超过 5 MB，前端先校验类型与大小，不合格不发请求）、选填原因 → 动态码 → multipart/form-data
// POST …/{pid_id}/activate（parts：expected_row_version、hjy_ignore_confirmed_at、
// hjy_ignore_evidence、reason）。30155（同平台同场景已有启用中的）只在服务端返回后提示，并重新读取
// 列表；20001 按 data.fields 在字段旁提示；20902 交给页签提示刷新并重新读取。
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { AuthClock } from '../../providers/auth/index.ts';
import { codePointLength } from '../../text-length.ts';
import { unionsTexts as t } from '../../texts/unions.ts';
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TYPES,
  REASON_MAX,
  activateUrl,
  beijingInputToIso,
  codeOf,
  fieldStatus,
  fieldsOf,
  isNetwork,
  type UnionPid,
} from './model.ts';
import type { StepUp } from './useStepUp.tsx';

type Field = 'hjy_ignore_confirmed_at' | 'hjy_ignore_evidence' | 'reason';
type Errors = Partial<Record<Field, string>>;

export interface ActivateDialogProps {
  readonly row: UnionPid;
  readonly clock: AuthClock;
  readonly stepUp: StepUp;
  readonly onClose: () => void;
  readonly onActivated: (row: UnionPid) => void;
  readonly onConflict: () => void;
  /** 30155 之后重新读取列表（对话框留着，显示提示）。 */
  readonly onRefresh: () => void;
}

const evidenceValid = (file: File): boolean =>
  EVIDENCE_TYPES.includes(file.type) && file.size <= EVIDENCE_MAX_BYTES;

interface Activation {
  readonly confirmedAt: string;
  readonly evidence: File;
  readonly reason: string;
}

export function ActivateDialog({
  row,
  clock,
  stepUp,
  onClose,
  onActivated,
  onConflict,
  onRefresh,
}: ActivateDialogProps): ReactElement | null {
  const getProvider = useDataProvider();
  const timeId = useId();
  const fileId = useId();
  const reasonId = useId();
  const [time, setTime] = useState('');
  const [evidence, setEvidence] = useState<File>();
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const operation = t.pids.activateOperation(row.pid);

  const send = async (activation: Activation, stepUpToken: string): Promise<void> => {
    if (!alive.current) return;
    setBusy(true);
    setMessage(undefined);
    setErrors({});
    // 每次发送都重新组装表单体（10003 重新验证后的重发同样带上截图）。
    const form = new FormData();
    form.append('expected_row_version', String(row.row_version));
    form.append('hjy_ignore_confirmed_at', activation.confirmedAt);
    form.append('hjy_ignore_evidence', activation.evidence, activation.evidence.name);
    if (activation.reason !== '') form.append('reason', activation.reason);
    const call = getProvider().custom;
    try {
      if (call === undefined) throw new Error('Missing custom data provider');
      const response = await call<UnionPid>({
        url: activateUrl(row.pid_id),
        method: 'post',
        payload: form,
        meta: { stepUpToken },
      });
      if (!alive.current) return;
      setBusy(false);
      onActivated(response.data);
    } catch (cause) {
      if (!alive.current) return;
      const code = codeOf(cause);
      if (code === 10003) {
        stepUp.ask({
          operation,
          again: true,
          run: (token) => void send(activation, token),
          onCancel: () => setBusy(false),
        });
        return;
      }
      setBusy(false);
      if (code === 20902) {
        onConflict();
        return;
      }
      if (code === 30155) {
        setMessage(t.pids.sceneActive);
        onRefresh();
        return;
      }
      if (code === 20001) {
        const fields = fieldsOf(cause);
        const next: Errors = {};
        if (fields.includes('hjy_ignore_confirmed_at'))
          next.hjy_ignore_confirmed_at = t.pids.confirmedAtRejected;
        if (fields.includes('hjy_ignore_evidence') || fields.includes('body'))
          next.hjy_ignore_evidence = t.pids.evidenceInvalid;
        if (fields.includes('reason')) next.reason = t.reasonInvalid;
        setErrors(next);
        if (Object.keys(next).length === 0) setMessage(t.failed);
        return;
      }
      if (code === 10403) setMessage(t.noPermissionAction);
      else if (isNetwork(cause)) setMessage(t.networkUnknown);
      else setMessage(t.failed);
    }
  };

  const submit = () => {
    if (busy) return;
    const next: Errors = {};
    const confirmedAt = beijingInputToIso(time);
    if (confirmedAt === undefined) next.hjy_ignore_confirmed_at = t.pids.confirmedAtRequired;
    else if (confirmedAt === null || Date.parse(confirmedAt) > clock.now())
      next.hjy_ignore_confirmed_at = t.pids.confirmedAtInvalid;
    if (evidence === undefined) next.hjy_ignore_evidence = t.pids.evidenceRequired;
    else if (!evidenceValid(evidence)) next.hjy_ignore_evidence = t.pids.evidenceInvalid;
    const note = reason.trim();
    if (codePointLength(note) > REASON_MAX) next.reason = t.reasonInvalid;
    setErrors(next);
    setMessage(undefined);
    if (Object.keys(next).length > 0) return;
    if (typeof confirmedAt !== 'string' || evidence === undefined) return;
    const activation: Activation = { confirmedAt, evidence, reason: note };
    stepUp.ask({ operation, run: (token) => void send(activation, token) });
  };

  const choose = (file: File | undefined) => {
    setEvidence(file);
    setErrors((previous) => {
      const next = { ...previous };
      if (file !== undefined && !evidenceValid(file))
        next.hjy_ignore_evidence = t.pids.evidenceInvalid;
      else delete next.hjy_ignore_evidence;
      return next;
    });
  };

  const item = (field: Field) => fieldStatus(errors[field]);

  // 动态码对话框打开时先收起（见 StepUp.open），填过的时间与选好的截图保留在本组件里。
  if (stepUp.open) return null;
  return (
    <Modal
      open
      centered
      width={560}
      title={t.pids.activateTitle(row.pid)}
      destroyOnHidden
      maskClosable={false}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t.cancel}
        </Button>,
        <Button
          key="submit"
          type="primary"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={submit}
        >
          {t.pids.activateSubmit}
        </Button>,
      ]}
    >
      <Flex vertical gap={12}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          {t.pids.activateIntro}
        </Typography.Paragraph>
        {message === undefined ? null : <Alert type="error" showIcon message={message} />}
        <Form layout="vertical" component={false}>
          <Form.Item
            label={t.pids.confirmedAtLabel}
            htmlFor={timeId}
            required
            {...item('hjy_ignore_confirmed_at')}
          >
            <Input
              id={timeId}
              type="datetime-local"
              step={1}
              value={time}
              disabled={busy}
              onChange={(event) => setTime(event.target.value)}
            />
          </Form.Item>
          <Form.Item
            label={t.pids.evidenceLabel}
            htmlFor={fileId}
            required
            extra={evidence === undefined ? t.pids.evidenceHint : evidence.name}
            {...item('hjy_ignore_evidence')}
          >
            <input
              id={fileId}
              type="file"
              accept={EVIDENCE_TYPES.join(',')}
              disabled={busy}
              onChange={(event) => choose(event.target.files?.[0])}
            />
          </Form.Item>
          <Form.Item
            label={t.reasonLabel}
            htmlFor={reasonId}
            {...item('reason')}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={reasonId}
              value={reason}
              rows={2}
              disabled={busy}
              placeholder={t.reasonPlaceholder}
              onChange={(event) => setReason(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Flex>
    </Modal>
  );
}
