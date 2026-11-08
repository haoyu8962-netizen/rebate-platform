// 告警手机号（画板 AdmUnionAlertPhoneAdd / AdmUnionAlertPhoneRemove，未定稿）：只显示脱敏号
// phone_masked；新增 POST、删除 DELETE ?phone_id=&expected_version=（无请求体），每次都先动态码，
// expected_version 用整组 version。20902 提示已被他人修改并重新读取，不自动重写。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Card, Flex, Form, Input, List, Modal, Typography } from 'antd';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { unionsTexts as t } from '../../texts/unions.ts';
import {
  PHONES_URL,
  REASON_MAX,
  codeOf,
  fieldsOf,
  isNetwork,
  reasonOf,
  type AlertPhone,
  type AlertPhones,
  fieldStatus,
  customOf,
} from './model.ts';
import type { StepUp } from './useStepUp.tsx';

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface Notice {
  readonly type: 'success' | 'error' | 'warning';
  readonly text: string;
}

export interface AlertPhonesBlockProps {
  readonly stepUp: StepUp;
  /** 每次读到或写成功后的整组号码；读不到为 undefined。 */
  readonly onPhones: (phones: AlertPhones | undefined) => void;
}

export function AlertPhonesBlock({ stepUp, onPhones }: AlertPhonesBlockProps): ReactElement {
  const getProvider = useDataProvider();
  const [phones, setPhonesState] = useState<AlertPhones>();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [notice, setNotice] = useState<Notice>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AlertPhone>();
  const phonesRef = useRef<AlertPhones | undefined>(undefined);
  const sequence = useRef(0);

  const setPhones = useCallback((next: AlertPhones | undefined) => {
    phonesRef.current = next;
    setPhonesState(next);
  }, []);

  useEffect(() => {
    onPhones(phones);
  }, [phones, onPhones]);

  const custom = useCallback(() => customOf(getProvider()), [getProvider]);

  const load = useCallback(() => {
    const request = ++sequence.current;
    return custom()<AlertPhones>({ url: PHONES_URL, method: 'get' }).then(
      (response) => {
        if (request !== sequence.current) return;
        setPhones(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (request !== sequence.current) return;
        setPhones(undefined);
        setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
      },
    );
  }, [custom, setPhones]);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const reload = () => {
    setStatus('loading');
    void load();
  };

  /** 写成功：用响应里的整组号码替换。 */
  const applied = (next: AlertPhones, text: string) => {
    sequence.current += 1;
    setPhones(next);
    setStatus('ready');
    setNotice({ type: 'success', text });
  };

  /** 写失败的公共处理；返回 true 表示已处理（对话框关闭）。 */
  const refused = (cause: unknown): boolean => {
    const code = codeOf(cause);
    if (code === 20902) {
      setAdding(false);
      setRemoving(undefined);
      setNotice({ type: 'warning', text: t.phones.conflict });
      void load();
      return true;
    }
    if (isNetwork(cause)) {
      // 结果未知：不重发，重新读取看服务端现在的号码。
      setAdding(false);
      setRemoving(undefined);
      setNotice({ type: 'error', text: t.networkUnknown });
      void load();
      return true;
    }
    return false;
  };

  const add = async (phone: string, note: string, stepUpToken: string): Promise<AddOutcome> => {
    const payload: Schema<'AdminUnionAlertPhoneAddRequest'> = {
      phone,
      expected_version: phonesRef.current?.version ?? 0,
      ...(note === '' ? {} : { reason: note }),
    };
    try {
      const response = await custom()<AlertPhones>({
        url: PHONES_URL,
        method: 'post',
        payload,
        meta: { stepUpToken },
      });
      setAdding(false);
      applied(response.data, t.phones.added);
      return { kind: 'done' };
    } catch (cause) {
      const code = codeOf(cause);
      if (code === 10003) return { kind: 'again' };
      if (refused(cause)) return { kind: 'done' };
      if (code === 10403) return { kind: 'message', text: t.noPermissionAction };
      if (code === 20001) {
        const fields = fieldsOf(cause);
        if (fields.includes('phone'))
          return {
            kind: 'phone',
            text: reasonOf(cause) === 'phone_invalid' ? t.phones.phoneInvalid : t.phones.phonesFull,
          };
        if (fields.includes('reason')) return { kind: 'reason', text: t.reasonInvalid };
      }
      return { kind: 'message', text: t.failed };
    }
  };

  const remove = async (target: AlertPhone, stepUpToken: string): Promise<RemoveOutcome> => {
    try {
      const response = await custom()<AlertPhones>({
        url: PHONES_URL,
        method: 'delete',
        query: {
          phone_id: target.phone_id,
          expected_version: String(phonesRef.current?.version ?? 0),
        },
        meta: { stepUpToken },
      });
      setRemoving(undefined);
      applied(response.data, t.phones.removed);
      return { kind: 'done' };
    } catch (cause) {
      const code = codeOf(cause);
      if (code === 10003) return { kind: 'again' };
      if (refused(cause)) return { kind: 'done' };
      if (code === 20001 && fieldsOf(cause).includes('phone_id')) {
        setRemoving(undefined);
        setNotice({ type: 'warning', text: t.phones.removeUnknown });
        void load();
        return { kind: 'done' };
      }
      return {
        kind: 'message',
        text: code === 10403 ? t.noPermissionAction : t.failed,
      };
    }
  };

  let content: ReactElement;
  if (status === 'loading') {
    content = (
      <Typography.Text type="secondary" role="status">
        {t.phones.loading}
      </Typography.Text>
    );
  } else if (status === 'forbidden') {
    content = <Typography.Text type="secondary">{t.noPermissionAction}</Typography.Text>;
  } else if (status === 'failed' || phones === undefined) {
    content = (
      <Flex align="center" gap={8}>
        <Typography.Text type="danger">{t.phones.loadFailed}</Typography.Text>
        <Button size="small" onClick={reload}>
          {t.phones.reload}
        </Button>
      </Flex>
    );
  } else if (phones.items.length === 0) {
    content = <Typography.Text type="secondary">{t.phones.empty}</Typography.Text>;
  } else {
    content = (
      <List<AlertPhone>
        size="small"
        bordered
        dataSource={phones.items}
        rowKey="phone_id"
        renderItem={(phone) => (
          <List.Item
            actions={[
              <Button
                key="remove"
                type="link"
                danger
                size="small"
                onClick={() => {
                  setNotice(undefined);
                  setRemoving(phone);
                }}
              >
                {t.phones.remove}
              </Button>,
            ]}
          >
            <Typography.Text>{phone.phone_masked}</Typography.Text>
          </List.Item>
        )}
      />
    );
  }

  return (
    <Card
      title={t.phones.title}
      extra={
        status === 'ready' ? (
          <Button
            onClick={() => {
              setNotice(undefined);
              setAdding(true);
            }}
          >
            {t.phones.add}
          </Button>
        ) : null
      }
    >
      <Flex vertical gap={12}>
        <Typography.Text type="secondary">{t.phones.description}</Typography.Text>
        {notice === undefined ? null : (
          <Alert
            type={notice.type}
            showIcon
            closable
            message={notice.text}
            onClose={() => setNotice(undefined)}
          />
        )}
        {content}
      </Flex>
      {adding ? (
        <AddPhoneDialog stepUp={stepUp} onClose={() => setAdding(false)} onAdd={add} />
      ) : null}
      {removing === undefined ? null : (
        <RemovePhoneDialog
          phone={removing}
          stepUp={stepUp}
          onClose={() => setRemoving(undefined)}
          onRemove={remove}
        />
      )}
    </Card>
  );
}

type AddOutcome =
  | { readonly kind: 'done' | 'again' }
  | { readonly kind: 'phone' | 'reason' | 'message'; readonly text: string };
type RemoveOutcome =
  { readonly kind: 'done' | 'again' } | { readonly kind: 'message'; readonly text: string };

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

function AddPhoneDialog({
  stepUp,
  onClose,
  onAdd,
}: {
  readonly stepUp: StepUp;
  readonly onClose: () => void;
  readonly onAdd: (phone: string, note: string, stepUpToken: string) => Promise<AddOutcome>;
}): ReactElement | null {
  const phoneId = useId();
  const reasonId = useId();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [phoneError, setPhoneError] = useState<string>();
  const [reasonError, setReasonError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useAlive();

  const run = async (value: string, note: string, stepUpToken: string) => {
    if (!alive.current) return;
    setBusy(true);
    const outcome = await onAdd(value, note, stepUpToken);
    if (!alive.current) return;
    if (outcome.kind === 'again') {
      stepUp.ask({
        operation: t.phones.addOperation,
        again: true,
        run: (token) => void run(value, note, token),
        onCancel: () => setBusy(false),
      });
      return;
    }
    setBusy(false);
    if (outcome.kind === 'phone') setPhoneError(outcome.text);
    else if (outcome.kind === 'reason') setReasonError(outcome.text);
    else if (outcome.kind === 'message') setMessage(outcome.text);
  };

  const submit = () => {
    if (busy) return;
    const value = phone.trim();
    const note = reason.trim();
    setMessage(undefined);
    setPhoneError(value === '' ? t.phones.phoneRequired : undefined);
    setReasonError(note.length > REASON_MAX ? t.reasonInvalid : undefined);
    if (value === '' || note.length > REASON_MAX) return;
    stepUp.ask({ operation: t.phones.addOperation, run: (token) => void run(value, note, token) });
  };

  // 动态码对话框打开时先收起（见 StepUp.open）。
  if (stepUp.open) return null;
  return (
    <Modal
      open
      centered
      width={480}
      title={t.phones.addTitle}
      destroyOnHidden
      maskClosable={false}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t.cancel}
        </Button>,
        <Button key="submit" type="primary" disabled={busy} onClick={submit}>
          {t.phones.addSubmit}
        </Button>,
      ]}
    >
      <Flex vertical gap={12}>
        {message === undefined ? null : <Alert type="error" showIcon message={message} />}
        <Form layout="vertical" component={false}>
          <Form.Item label={t.phones.phoneLabel} htmlFor={phoneId} {...fieldStatus(phoneError)}>
            <Input
              id={phoneId}
              value={phone}
              inputMode="numeric"
              autoComplete="off"
              maxLength={20}
              placeholder={t.phones.phonePlaceholder}
              onChange={(event) => {
                setPhone(event.target.value);
                setPhoneError(undefined);
              }}
            />
          </Form.Item>
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
              placeholder={t.reasonPlaceholder}
              onChange={(event) => setReason(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Flex>
    </Modal>
  );
}

function RemovePhoneDialog({
  phone,
  stepUp,
  onClose,
  onRemove,
}: {
  readonly phone: AlertPhone;
  readonly stepUp: StepUp;
  readonly onClose: () => void;
  readonly onRemove: (phone: AlertPhone, stepUpToken: string) => Promise<RemoveOutcome>;
}): ReactElement | null {
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const alive = useAlive();

  const run = async (stepUpToken: string) => {
    if (!alive.current) return;
    setBusy(true);
    const outcome = await onRemove(phone, stepUpToken);
    if (!alive.current) return;
    if (outcome.kind === 'again') {
      stepUp.ask({
        operation: t.phones.removeOperation(phone.phone_masked),
        again: true,
        run: (token) => void run(token),
        onCancel: () => setBusy(false),
      });
      return;
    }
    setBusy(false);
    if (outcome.kind === 'message') setMessage(outcome.text);
  };

  const submit = () => {
    if (busy) return;
    setMessage(undefined);
    stepUp.ask({
      operation: t.phones.removeOperation(phone.phone_masked),
      run: (token) => void run(token),
    });
  };

  // 动态码对话框打开时先收起（见 StepUp.open）。
  if (stepUp.open) return null;
  return (
    <Modal
      open
      centered
      width={480}
      title={t.phones.removeTitle}
      destroyOnHidden
      maskClosable={false}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t.cancel}
        </Button>,
        <Button key="submit" type="primary" danger disabled={busy} onClick={submit}>
          {t.phones.removeSubmit}
        </Button>,
      ]}
    >
      <Flex vertical gap={12}>
        {message === undefined ? null : <Alert type="error" showIcon message={message} />}
        <Typography.Paragraph style={{ margin: 0 }}>
          {t.phones.removeConfirm(phone.phone_masked)}
        </Typography.Paragraph>
      </Flex>
    </Modal>
  );
}
