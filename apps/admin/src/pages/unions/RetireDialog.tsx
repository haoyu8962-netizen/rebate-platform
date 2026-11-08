// 【停用】（只 active 行）：确认 + 选填原因 → 动态码 → POST …/{pid_id}/retire（expected_row_version、
// reason）。停用的推广位仍留在白名单里，之后不再有任何操作；20902 交给页签提示刷新并重新读取。
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { unionsTexts as t } from '../../texts/unions.ts';
import {
  REASON_MAX,
  codeOf,
  fieldStatus,
  fieldsOf,
  isNetwork,
  retireUrl,
  type PidRetireRequest,
  type UnionPid,
} from './model.ts';
import type { StepUp } from './useStepUp.tsx';

export interface RetireDialogProps {
  readonly row: UnionPid;
  readonly stepUp: StepUp;
  readonly onClose: () => void;
  readonly onRetired: (row: UnionPid) => void;
  readonly onConflict: () => void;
}

export function RetireDialog({
  row,
  stepUp,
  onClose,
  onRetired,
  onConflict,
}: RetireDialogProps): ReactElement | null {
  const getProvider = useDataProvider();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const operation = t.pids.retireOperation(row.pid);

  const send = async (payload: PidRetireRequest, stepUpToken: string): Promise<void> => {
    if (!alive.current) return;
    setBusy(true);
    setMessage(undefined);
    setReasonError(undefined);
    const call = getProvider().custom;
    try {
      if (call === undefined) throw new Error('Missing custom data provider');
      const response = await call<UnionPid>({
        url: retireUrl(row.pid_id),
        method: 'post',
        payload,
        meta: { stepUpToken },
      });
      if (!alive.current) return;
      setBusy(false);
      onRetired(response.data);
    } catch (cause) {
      if (!alive.current) return;
      const code = codeOf(cause);
      if (code === 10003) {
        stepUp.ask({
          operation,
          again: true,
          run: (token) => void send(payload, token),
          onCancel: () => setBusy(false),
        });
        return;
      }
      setBusy(false);
      if (code === 20902) {
        onConflict();
        return;
      }
      if (code === 20001 && fieldsOf(cause).includes('reason')) {
        setReasonError(t.reasonInvalid);
        return;
      }
      if (code === 10403) setMessage(t.noPermissionAction);
      else if (isNetwork(cause)) setMessage(t.networkUnknown);
      else setMessage(t.failed);
    }
  };

  const submit = () => {
    if (busy) return;
    const note = reason.trim();
    if (note.length > REASON_MAX) {
      setReasonError(t.reasonInvalid);
      return;
    }
    setReasonError(undefined);
    setMessage(undefined);
    const payload: PidRetireRequest = {
      expected_row_version: row.row_version,
      ...(note === '' ? {} : { reason: note }),
    };
    stepUp.ask({ operation, run: (token) => void send(payload, token) });
  };

  // 动态码对话框打开时先收起（见 StepUp.open）。
  if (stepUp.open) return null;
  return (
    <Modal
      open
      centered
      width={480}
      title={t.pids.retireTitle(row.pid)}
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
          danger
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={submit}
        >
          {t.pids.retireSubmit}
        </Button>,
      ]}
    >
      <Flex vertical gap={12}>
        <Typography.Paragraph style={{ margin: 0 }}>
          {t.pids.retireConfirm(row.pid)}
        </Typography.Paragraph>
        {message === undefined ? null : <Alert type="error" showIcon message={message} />}
        <Form layout="vertical" component={false}>
          <Form.Item
            label={t.reasonLabel}
            htmlFor={reasonId}
            {...fieldStatus(reasonError)}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={reasonId}
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
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
