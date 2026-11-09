// 用户列表标题行的【导出记录】【导出】（AdmUsers；契约 adminCreateExport，resource=users）。
// 【导出】打开导出对话框：默认脱敏，确认后发一次 POST /admin/v1/exports，body 只有 resource 与当前
// 已应用的筛选（不含分页），不带原因与二次验证凭证。持 pii.reveal_phone 时可勾选「导出完整手机号」：
// 原因必填（去首尾空白后 1–200 字），经动态码二次验证后带 X-Step-Up-Token 发，body 加
// unmasked 与 reason。接口不带 Idempotency-Key、每次调用都新建任务，所以在途时不再发第二次。
// 成功后关闭对话框，用 message 提示并指向【导出记录】；失败时对话框留着，可改后再试或取消。
import type { Schema } from '@couli/contracts-ts';
import { ExportOutlined, SafetyOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import { Button, Checkbox, Flex, Form, Input, Modal, Typography, message, theme } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { StepUpModal } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { codePointLength } from '../../text-length.ts';
import { usersTexts } from '../../texts/users.ts';
import { REASON_MAX, type RiskState } from './model.ts';
import { useVerifiedWrite } from './relations/useVerifiedWrite.ts';

const t = usersTexts.export;
const EXPORTS_URL = '/admin/v1/exports';
const RECORDS_ROUTE = '/exports';

type ExportRequest = Schema<'AdminExportCreateUsersRequest'>;
type Notify = ReturnType<typeof message.useMessage>[0];

/** 一次导出的结果：已创建，或某类失败（原因被拒时提示在原因旁）。 */
type Outcome = 'created' | 'forbidden' | 'filters' | 'reason' | 'failed';

function fieldsOf(cause: AdminApiError): readonly unknown[] {
  const data = cause.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields as unknown[];
  return [];
}

function outcomeOf(cause: unknown): Outcome {
  if (!(cause instanceof AdminApiError)) return 'failed';
  // 202 Accepted 带新任务：data provider 只把 200 当成功。
  if (cause.kind === 'http' && cause.httpStatus === 202) return 'created';
  if (cause.code === 10403) return 'forbidden';
  if (cause.code === 20001) {
    const fields = fieldsOf(cause);
    if (fields.includes('reason')) return 'reason';
    if (fields.includes('filters')) return 'filters';
  }
  return 'failed';
}

function reasonError(reason: string): string | undefined {
  const value = reason.trim();
  if (value === '') return t.reasonEmpty;
  if (codePointLength(value) > REASON_MAX) return t.reasonTooLong;
  return undefined;
}

export interface UsersExportEntriesProps {
  /** 当前已应用的风控状态筛选（all = 未筛选）。 */
  readonly risk: RiskState | 'all';
  /** 筛选的中文名（对话框里说明导出范围）。 */
  readonly riskText: string;
  readonly canReveal: boolean;
}

/** 标题行右侧：【导出记录】链接与【导出】按钮，以及导出对话框。 */
export function UsersExportEntries({
  risk,
  riskText,
  canReveal,
}: UsersExportEntriesProps): ReactElement {
  const [notice, contextHolder] = message.useMessage();
  const [opening, setOpening] = useState(0);
  const [open, setOpen] = useState(false);
  const filters: ExportRequest['filters'] = risk === 'all' ? {} : { risk_state: risk };
  return (
    <Flex align="center" gap={12}>
      {contextHolder}
      <Link to={RECORDS_ROUTE}>{t.records}</Link>
      <Button
        autoInsertSpace={false}
        icon={<ExportOutlined aria-hidden />}
        onClick={() => {
          if (open) return;
          setOpening((value) => value + 1);
          setOpen(true);
        }}
      >
        {t.action}
      </Button>
      {open ? (
        <ExportDialog
          key={opening}
          filters={filters}
          riskText={riskText}
          canReveal={canReveal}
          notify={notice}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Flex>
  );
}

interface ExportDialogProps {
  readonly filters: ExportRequest['filters'];
  readonly riskText: string;
  readonly canReveal: boolean;
  readonly notify: Notify;
  readonly onClose: () => void;
}

function ExportDialog({
  filters,
  riskText,
  canReveal,
  notify,
  onClose,
}: ExportDialogProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const reasonId = useId();
  const [unmasked, setUnmasked] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonFieldError, setReasonFieldError] = useState<string>();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const finish = (outcome: Outcome) => {
    switch (outcome) {
      case 'created':
        void notify.success(t.created);
        onClose();
        return;
      case 'reason':
        setReasonFieldError(t.reasonRefused);
        return;
      case 'forbidden':
        void notify.error(t.forbidden);
        return;
      case 'filters':
        void notify.error(t.filtersInvalid);
        return;
      case 'failed':
        void notify.error(t.failed);
        return;
    }
  };

  const write = useVerifiedWrite<ExportRequest, unknown>({
    url: EXPORTS_URL,
    onSaved: () => finish('created'),
    onFailed: (cause) => finish(outcomeOf(cause)),
  });
  const busy = sending || write.phase !== 'idle';

  const sendMasked = async () => {
    sendingRef.current = true;
    setSending(true);
    const payload: ExportRequest = { resource: 'users', filters };
    let outcome: Outcome;
    try {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      await custom<Schema<'AdminExport'>>({ url: EXPORTS_URL, method: 'post', payload });
      outcome = 'created';
    } catch (cause) {
      outcome = outcomeOf(cause);
    }
    sendingRef.current = false;
    if (!alive.current) return;
    setSending(false);
    finish(outcome);
  };

  const submit = () => {
    // 每次调用都新建任务：在途（含动态码验证中）时不再发。
    if (sendingRef.current || write.phase !== 'idle') return;
    if (!unmasked) {
      void sendMasked();
      return;
    }
    const error = reasonError(reason);
    if (error !== undefined) {
      setReasonFieldError(error);
      return;
    }
    setReasonFieldError(undefined);
    write.start({ resource: 'users', filters, unmasked: true, reason: reason.trim() });
  };

  const cancel = () => {
    if (busy) return;
    onClose();
  };

  return (
    <>
      <Modal
        open
        centered
        width={520}
        title={t.dialogTitle}
        destroyOnHidden
        maskClosable={false}
        closable={!busy}
        onCancel={cancel}
        footer={
          <Flex justify="end" gap={8}>
            <Button disabled={busy} onClick={cancel}>
              {t.cancel}
            </Button>
            <Button
              type="primary"
              icon={unmasked ? <SafetyOutlined aria-hidden /> : <ExportOutlined aria-hidden />}
              loading={busy}
              onClick={submit}
            >
              {unmasked ? t.submitVerified : t.submit}
            </Button>
          </Flex>
        }
      >
        <Flex vertical gap={12} style={{ paddingTop: 8 }}>
          <Typography.Text>{t.scope(riskText)}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {t.maskedNote}
          </Typography.Text>
          {canReveal ? (
            <Flex vertical gap={4}>
              <Checkbox
                checked={unmasked}
                disabled={busy}
                onChange={(event) => {
                  setUnmasked(event.target.checked);
                  if (!event.target.checked) {
                    setReason('');
                    setReasonFieldError(undefined);
                  }
                }}
              >
                {t.unmaskLabel}
              </Checkbox>
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {t.unmaskNote}
              </Typography.Text>
            </Flex>
          ) : null}
          {canReveal && unmasked ? (
            <Form layout="vertical" component="div">
              <Form.Item
                label={t.reasonLabel}
                htmlFor={reasonId}
                required
                validateStatus={reasonFieldError === undefined ? '' : 'error'}
                help={reasonFieldError}
                extra={t.reasonExtra}
                style={{ marginBottom: 0 }}
              >
                <Input.TextArea
                  id={reasonId}
                  value={reason}
                  rows={3}
                  aria-required
                  disabled={busy}
                  showCount
                  count={{ max: REASON_MAX, strategy: codePointLength }}
                  placeholder={t.reasonPlaceholder}
                  onChange={(event) => {
                    setReason(event.target.value);
                    if (reasonFieldError !== undefined)
                      setReasonFieldError(reasonError(event.target.value));
                  }}
                />
              </Form.Item>
            </Form>
          ) : null}
        </Flex>
      </Modal>
      <StepUpModal
        open={write.phase === 'verify'}
        tier="totp"
        operation={t.stepUpOperation}
        details={[t.stepUpScope(riskText), ...(write.again ? [t.stepUpAgain] : [])]}
        onSubmit={write.verify}
        onClose={write.cancel}
        onVerified={write.onVerified}
      />
    </>
  );
}
