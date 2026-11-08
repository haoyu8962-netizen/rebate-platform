// 测试发送弹窗（AdmNotifySmsTestSend*）：测试对象（新配置与当前生效；首次登记不显示当前生效）、
// 发送到（取 adminGetMyPermissions 的 verify_phone_masked，脱敏、不可改）、样例变量、频控提醒；
// 【发送测试短信】之后结果换同一弹窗内容：已受理【稍后再启用】【启用新配置】/ 未受理【关闭】
// 【修改配置】/ 未发送（未登记验证手机号）。首次登记时提到原配置的半句都不显示（D10-339 ④）。
import { Alert, Button, Flex, Modal, Tag, Typography } from 'antd';
import type { ReactElement } from 'react';
import { messagesTexts as t } from '../../texts/messages.ts';

export type TestView = 'confirm' | 'busy' | 'accepted' | 'failed' | 'noPhone';

export interface TestDialog {
  readonly code: string;
  readonly variant: string;
  readonly view: TestView;
  /** 从抽屉【保存】来（保存并测试），还是列表行（对已存的新配置测试）。 */
  readonly source: 'save' | 'row';
  /** 没有在用配置（首次登记）。 */
  readonly first: boolean;
  readonly fresh: { readonly sign_name: string; readonly template_code: string };
  readonly current: { readonly sign_name: string; readonly template_code: string } | null;
  readonly variables: readonly string[];
  /** 已受理时短信发到的号码（脱敏）。 */
  readonly sentTo?: string | null;
  /** 未发送时新配置是否已保存为「待测试」。 */
  readonly saved?: boolean;
  /** 未受理的错误码（50301 / 50401）。 */
  readonly failure?: number;
  /** 资金类编码而没有 content.fund_terms：不给【启用新配置】。 */
  readonly fundBlocked: boolean;
}

export interface TestSendModalProps {
  readonly dialog: TestDialog;
  /** 页面读到的验证手机号（脱敏）。 */
  readonly phone: string | null;
  readonly onSend: () => void;
  readonly onClose: () => void;
  readonly onEnable: () => void;
  readonly onRevise: () => void;
}

function Line({ label, children }: { label: string; children: string }): ReactElement {
  return (
    <Typography.Text>
      {label}
      {t.colon}
      {children}
    </Typography.Text>
  );
}

const pair = (value: { sign_name: string; template_code: string }): string =>
  t.signedCode(value.sign_name, value.template_code);

export function TestSendModal({
  dialog,
  phone,
  onSend,
  onClose,
  onEnable,
  onRevise,
}: TestSendModalProps): ReactElement {
  const { view, first } = dialog;
  const busy = view === 'busy';

  let title: string;
  let body: ReactElement;
  let footer: ReactElement[];
  if (view === 'accepted') {
    title = t.test.acceptedTitle;
    body = (
      <Flex vertical gap={8}>
        <Alert
          type="success"
          showIcon
          message={
            typeof dialog.sentTo === 'string'
              ? t.test.acceptedBody(dialog.sentTo)
              : t.test.acceptedBodyNoPhone
          }
        />
        <Typography.Text>
          {t.test.acceptedNext}
          {first ? null : t.test.acceptedKept}
        </Typography.Text>
        {dialog.fundBlocked ? (
          <Typography.Text type="secondary">{t.enableFundNeeded}</Typography.Text>
        ) : null}
      </Flex>
    );
    footer = [
      <Button key="later" autoInsertSpace={false} onClick={onClose}>
        {t.later}
      </Button>,
    ];
    if (!dialog.fundBlocked)
      footer.push(
        <Button key="enable" type="primary" autoInsertSpace={false} onClick={onEnable}>
          {t.enable}
        </Button>,
      );
  } else if (view === 'failed') {
    title = t.test.failedTitle;
    body = (
      <Flex vertical gap={8}>
        <Alert
          type="error"
          showIcon
          message={t.test.failedBody(t.test.failedReason(dialog.failure))}
          description={first ? t.test.failedNext : `${t.test.failedKept}${t.test.failedNext}`}
        />
      </Flex>
    );
    footer = [
      <Button key="close" autoInsertSpace={false} onClick={onClose}>
        {t.close}
      </Button>,
      <Button key="revise" type="primary" autoInsertSpace={false} onClick={onRevise}>
        {t.revise}
      </Button>,
    ];
  } else if (view === 'noPhone') {
    title = t.test.noPhoneTitle;
    body = (
      <Flex vertical gap={8}>
        <Alert type="warning" showIcon message={t.test.noPhoneBody} />
        {dialog.saved === true ? (
          <Typography.Text>
            {t.test.noPhoneSaved}
            {first ? null : t.test.noPhoneKept}
          </Typography.Text>
        ) : null}
      </Flex>
    );
    footer = [
      <Button key="close" type="primary" autoInsertSpace={false} onClick={onClose}>
        {t.close}
      </Button>,
    ];
  } else {
    title = t.test.title(dialog.code, dialog.variant);
    body = (
      <Flex vertical gap={8}>
        <Typography.Text strong>{t.test.target}</Typography.Text>
        <Line label={t.test.fresh}>{pair(dialog.fresh)}</Line>
        {first || dialog.current === null ? null : (
          <Line label={t.test.current}>{pair(dialog.current)}</Line>
        )}
        <Typography.Text>
          {t.test.to}
          {t.colon}
          <Typography.Text strong>{phone ?? t.dash}</Typography.Text>
          <Typography.Text type="secondary">{t.paren(t.test.toNote)}</Typography.Text>
        </Typography.Text>
        <Flex vertical gap={4}>
          <Typography.Text>{t.test.samples}</Typography.Text>
          <Flex wrap gap={4}>
            {dialog.variables.length === 0 ? (
              <Typography.Text type="secondary">{t.test.sampleNone}</Typography.Text>
            ) : (
              dialog.variables.map((name) => <Tag key={name}>{`\${${name}}`}</Tag>)
            )}
          </Flex>
          <Typography.Text type="secondary">{t.test.sampleNote}</Typography.Text>
        </Flex>
        <Typography.Text type="secondary">{t.test.rateNote}</Typography.Text>
      </Flex>
    );
    footer = [
      <Button key="cancel" autoInsertSpace={false} disabled={busy} onClick={onClose}>
        {t.cancel}
      </Button>,
      <Button key="send" type="primary" autoInsertSpace={false} loading={busy} onClick={onSend}>
        {t.test.send}
      </Button>,
    ];
  }

  return (
    <Modal
      open
      width={520}
      title={title}
      maskClosable={false}
      closable={!busy}
      keyboard={!busy}
      onCancel={() => {
        if (!busy) onClose();
      }}
      footer={
        <Flex justify="end" gap={8}>
          {footer}
        </Flex>
      }
    >
      {body}
    </Modal>
  );
}
