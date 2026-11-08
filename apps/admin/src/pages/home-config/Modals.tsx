// Dialogs of the home page configuration page: publish a draft (gray 1–99 or full 100), adjust
// the gray percentage, and the plain confirmation of 转为全量 / 停止灰度 / 回滚. The percentage is
// checked as typed (an integer 1–99, never rounded or turned into 100); nothing is sent until the
// operator confirms, and the confirm button stays disabled while the write is under way.
import { Alert, Button, Flex, Input, Modal, Radio, Typography } from 'antd';
import { useState, type ReactElement } from 'react';
import { homeConfigTexts as t } from '../../texts/home-config.ts';
import { checkGrayPercent } from './model.ts';

const small = { fontSize: 12 } as const;

interface FooterProps {
  readonly submit: string;
  readonly danger?: boolean;
  readonly writing: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}

function Footer({ submit, danger = false, writing, onCancel, onSubmit }: FooterProps) {
  return (
    <Flex justify="end" gap={8}>
      <Button disabled={writing} onClick={onCancel}>
        {t.actions.cancel}
      </Button>
      <Button type="primary" danger={danger} disabled={writing} onClick={onSubmit}>
        {submit}
      </Button>
    </Flex>
  );
}

function PercentField({
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Flex vertical gap={4}>
      <Typography.Text type="secondary" style={small}>
        {label}
      </Typography.Text>
      <Flex align="center" gap={8}>
        <Input
          role="spinbutton"
          inputMode="numeric"
          autoComplete="off"
          aria-label={label}
          aria-invalid={error === undefined ? undefined : true}
          status={error === undefined ? '' : 'error'}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={{ width: 120 }}
        />
        <Typography.Text>{t.publish.percentSuffix}</Typography.Text>
      </Flex>
      {error === undefined ? null : (
        <Typography.Text type="danger" role="alert" style={small}>
          {error}
        </Typography.Text>
      )}
    </Flex>
  );
}

export interface PublishModalProps {
  readonly version: number;
  /** Whether the page has a fully released version (otherwise only 100 is accepted). */
  readonly hasCurrent: boolean;
  readonly writing: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (grayPercent: number) => void;
}

export function PublishModal({
  version,
  hasCurrent,
  writing,
  onCancel,
  onSubmit,
}: PublishModalProps): ReactElement {
  const [mode, setMode] = useState<'partial' | 'full'>(hasCurrent ? 'partial' : 'full');
  const [percent, setPercent] = useState('10');
  const [error, setError] = useState<string>();
  const submit = () => {
    if (writing) return;
    if (mode === 'full') {
      onSubmit(100);
      return;
    }
    const checked = checkGrayPercent(percent);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(undefined);
    onSubmit(checked.value);
  };
  return (
    <Modal
      open
      centered
      width={480}
      title={t.publish.title(version)}
      destroyOnHidden
      maskClosable={false}
      closable={!writing}
      onCancel={() => {
        if (!writing) onCancel();
      }}
      footer={
        <Footer submit={t.publish.submit} writing={writing} onCancel={onCancel} onSubmit={submit} />
      }
    >
      <Flex vertical gap={16} style={{ paddingTop: 8 }}>
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={small}>
            {t.publish.mode}
          </Typography.Text>
          <Radio.Group
            value={mode}
            disabled={writing}
            onChange={(event) => {
              setMode(event.target.value as 'partial' | 'full');
              setError(undefined);
            }}
          >
            <Radio value="partial" disabled={!hasCurrent}>
              {t.publish.gray}
            </Radio>
            <Radio value="full">{t.publish.full}</Radio>
          </Radio.Group>
        </Flex>
        {hasCurrent ? null : <Alert type="info" showIcon message={t.publish.onlyFull} />}
        {mode === 'partial' ? (
          <Flex vertical gap={4}>
            <PercentField
              label={t.publish.percent}
              value={percent}
              error={error}
              disabled={writing}
              onChange={(value) => {
                setPercent(value);
                setError(undefined);
              }}
            />
            <Typography.Text type="secondary" style={small}>
              {t.publish.bucketHint}
            </Typography.Text>
          </Flex>
        ) : null}
      </Flex>
    </Modal>
  );
}

export interface GrayModalProps {
  readonly version: number;
  readonly current: number;
  readonly writing: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (grayPercent: number) => void;
}

export function GrayModal({
  version,
  current,
  writing,
  onCancel,
  onSubmit,
}: GrayModalProps): ReactElement {
  const [percent, setPercent] = useState(String(current));
  const [error, setError] = useState<string>();
  const submit = () => {
    if (writing) return;
    const checked = checkGrayPercent(percent);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(undefined);
    onSubmit(checked.value);
  };
  return (
    <Modal
      open
      centered
      width={440}
      title={t.gray.title(version)}
      destroyOnHidden
      maskClosable={false}
      closable={!writing}
      onCancel={() => {
        if (!writing) onCancel();
      }}
      footer={
        <Footer submit={t.gray.submit} writing={writing} onCancel={onCancel} onSubmit={submit} />
      }
    >
      <Flex vertical gap={8} style={{ paddingTop: 8 }}>
        <PercentField
          label={t.gray.percent}
          value={percent}
          error={error}
          disabled={writing}
          onChange={(value) => {
            setPercent(value);
            setError(undefined);
          }}
        />
        <Typography.Text type="secondary" style={small}>
          {t.gray.hint}
        </Typography.Text>
      </Flex>
    </Modal>
  );
}

export interface ConfirmActionModalProps {
  readonly title: string;
  readonly body: string;
  readonly submit: string;
  readonly danger: boolean;
  readonly writing: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
}

export function ConfirmActionModal({
  title,
  body,
  submit,
  danger,
  writing,
  onCancel,
  onSubmit,
}: ConfirmActionModalProps): ReactElement {
  return (
    <Modal
      open
      centered
      width={440}
      title={title}
      destroyOnHidden
      maskClosable={false}
      closable={!writing}
      onCancel={() => {
        if (!writing) onCancel();
      }}
      footer={
        <Footer
          submit={submit}
          danger={danger}
          writing={writing}
          onCancel={onCancel}
          onSubmit={() => {
            if (!writing) onSubmit();
          }}
        />
      }
    >
      <Typography.Paragraph style={{ marginBlock: 8 }}>{body}</Typography.Paragraph>
    </Modal>
  );
}
