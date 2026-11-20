// 【新建调账】抽屉（adminCreateAdjustment 新建形状，fund.adjust，一步提交并生效）：用户 ID、方向（调增 /
// 调减）、金额（元，只经 @couli/money 换成整数分，不设上限）、原因码（对账修正 / 打款追回 / 其他）、关联单据
// （单据类型 + 单据号逐张添加，≤ 10、不重复）、原因说明、对方科目（只对账修正与其他，四选一；联盟应收另选
// 平台）。本地校验不过不发任何请求；通过后短信验证、只发一次 POST（流程见 useAdjustmentWrite）。
// 写入被拒时抽屉保留、已填不丢；成功后由页面关抽屉、提示新单号与调账前后可用余额并刷新列表。
// 结果未知（没拿到带统一外壳的回答）时所有输入锁定、不能关闭，只有【重试】（原键原请求体）与【去列表核对】。
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Drawer,
  Flex,
  Form,
  Input,
  Radio,
  Select,
  Table,
  Typography,
  theme,
} from 'antd';
import { useId, useState, type ReactElement } from 'react';
import { plannedButtonProps } from '../../components/planned/index.ts';
import type { MarkerClock } from '../../components/unknown-marker/index.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import { directionLabel, reasonLabel, refTypeLabel } from './model.ts';
import { useAdjustmentWrite } from './useAdjustmentWrite.tsx';
import {
  CHOOSABLE_REASONS,
  CHOOSABLE_SUBJECTS,
  EMPTY_NEW,
  PLATFORMS,
  REF_TYPES,
  amountFen,
  checkNew,
  feedback,
  hasErrors,
  needsSubject,
  newBody,
  refAddError,
  writeErrorText,
  yuanOf,
  type ChoosableReason,
  type ChoosableSubject,
  type Direction,
  type Executed,
  type NewDraft,
  type PlatformCode,
  type Ref,
  type RefType,
} from './write.ts';

const w = adjustmentsTexts.write;
const l = w.labels;

export interface CreateDrawerProps {
  readonly open: boolean;
  /** adminCreateAdjustment is still planned: the submit is greyed out. */
  readonly planned: boolean;
  /** The page's injected clock: the moment of the result-unknown marker (F1-08at). */
  readonly clock: MarkerClock;
  readonly onClose: () => void;
  readonly onCreated: (executed: Executed) => void;
  /** 【去列表核对】 while the result is unknown: close and read the list again. */
  readonly onCheck: () => void;
}

const DIRECTIONS: readonly Direction[] = ['increase', 'decrease'];

/** One opening of the drawer (the page mounts a new one for every opening: an empty form). */
export function CreateDrawer({
  open,
  planned,
  onClose,
  onCreated,
  onCheck,
  clock,
}: CreateDrawerProps): ReactElement {
  const { token } = theme.useToken();
  const ids = {
    user: useId(),
    amount: useId(),
    reason: useId(),
    refType: useId(),
    refId: useId(),
    note: useId(),
    subject: useId(),
    platform: useId(),
    phone: useId(),
  };
  const [draft, setDraft] = useState<NewDraft>(EMPTY_NEW);
  const [refType, setRefType] = useState<RefType>();
  const [refId, setRefId] = useState('');
  const [addError, setAddError] = useState<string>();
  /** After the first press of submit the local checks are shown (and kept up to date). */
  const [checked, setChecked] = useState(false);
  const [writeError, setWriteError] = useState<string>();

  const write = useAdjustmentWrite({
    operation: w.createOperation,
    clock,
    onDone: onCreated,
    onFailed: (cause) => setWriteError(writeErrorText(cause)),
  });

  /** The result of the last submission is unknown: nothing can be changed. */
  const locked = write.unknown;
  const errors = checked ? checkNew(draft) : {};
  const change = (patch: Partial<NewDraft>) => setDraft((previous) => ({ ...previous, ...patch }));

  const addRef = () => {
    if (locked) return;
    const error = refAddError(draft.refs, refType, refId);
    if (error !== undefined || refType === undefined) {
      setAddError(error);
      return;
    }
    const ref: Ref = { ref_type: refType, ref_id: refId.trim() };
    change({ refs: [...draft.refs, ref] });
    setRefId('');
    setAddError(undefined);
  };
  const removeRef = (index: number) => {
    if (locked) return;
    change({ refs: draft.refs.filter((_, position) => position !== index) });
  };

  const submit = () => {
    if (write.busy || write.phoneMissing || locked || planned) return;
    setChecked(true);
    if (hasErrors(checkNew(draft))) return;
    setWriteError(undefined);
    write.submit(newBody(draft));
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

  const fen = amountFen(draft.amount);
  const user = draft.user.trim();
  const preview =
    user !== '' && draft.direction !== undefined && fen !== undefined && draft.reason !== undefined
      ? w.preview(user, directionLabel(draft.direction), yuanOf(fen), reasonLabel(draft.reason))
      : undefined;

  const subjectShown = needsSubject(draft.reason);
  const platformShown = subjectShown && draft.subject === 'UNION_RECEIVABLE';
  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const item = { marginBottom: token.margin } as const;

  const footer = locked ? (
    <Flex justify="flex-end" gap={8}>
      <Button autoInsertSpace={false} disabled={write.busy} onClick={check}>
        {w.check}
      </Button>
      <Button type="primary" autoInsertSpace={false} disabled={write.busy} onClick={retry}>
        {w.retry}
      </Button>
    </Flex>
  ) : (
    <Flex justify="flex-end" gap={8}>
      <Button autoInsertSpace={false} disabled={write.busy} onClick={close}>
        {w.cancel}
      </Button>
      <Button
        type="primary"
        autoInsertSpace={false}
        disabled={write.busy}
        aria-disabled={write.phoneMissing ? true : undefined}
        aria-describedby={write.phoneMissing ? ids.phone : undefined}
        {...plannedButtonProps(planned)}
        onClick={submit}
      >
        {w.submit}
      </Button>
    </Flex>
  );

  return (
    <Drawer
      open={open}
      width={640}
      title={w.createTitle}
      destroyOnHidden
      maskClosable={false}
      closable={!locked}
      keyboard={!locked}
      footer={footer}
      onClose={close}
    >
      <Flex vertical gap={16}>
        <Alert type="info" showIcon role="note" message={w.oneStep} />
        <Form layout="vertical" component="div">
          <Form.Item label={l.user} htmlFor={ids.user} {...feedback(errors.user)} style={item}>
            <Input
              id={ids.user}
              value={draft.user}
              disabled={locked}
              autoComplete="off"
              style={code}
              onChange={(event) => change({ user: event.target.value })}
            />
          </Form.Item>
          <Form.Item label={l.direction} {...feedback(errors.direction)} style={item}>
            <Radio.Group
              value={draft.direction ?? null}
              disabled={locked}
              options={DIRECTIONS.map((value) => ({ value, label: directionLabel(value) }))}
              onChange={(event) => change({ direction: event.target.value as Direction })}
            />
          </Form.Item>
          <Form.Item
            label={l.amount}
            htmlFor={ids.amount}
            {...feedback(errors.amount)}
            style={item}
          >
            <Input
              id={ids.amount}
              value={draft.amount}
              disabled={locked}
              inputMode="decimal"
              autoComplete="off"
              style={{ width: 240, fontVariantNumeric: 'tabular-nums' }}
              onChange={(event) => change({ amount: event.target.value })}
            />
          </Form.Item>
          <Form.Item
            label={l.reason}
            htmlFor={ids.reason}
            {...feedback(errors.reason)}
            style={item}
          >
            <Select<ChoosableReason>
              id={ids.reason}
              value={draft.reason ?? null}
              disabled={locked}
              virtual={false}
              style={{ width: 240 }}
              options={CHOOSABLE_REASONS.map((value) => ({ value, label: reasonLabel(value) }))}
              onChange={(value: ChoosableReason) => change({ reason: value })}
            />
          </Form.Item>
          <Flex wrap gap={8} align="flex-start">
            <Form.Item
              label={l.refType}
              htmlFor={ids.refType}
              style={{ marginBottom: token.marginXS }}
            >
              <Select<RefType>
                id={ids.refType}
                value={refType ?? null}
                disabled={locked}
                virtual={false}
                style={{ width: 160 }}
                options={REF_TYPES.map((value) => ({ value, label: refTypeLabel(value) }))}
                onChange={(value: RefType) => {
                  setRefType(value);
                  setAddError(undefined);
                }}
              />
            </Form.Item>
            <Form.Item
              label={l.refId}
              htmlFor={ids.refId}
              {...feedback(addError)}
              style={{ marginBottom: token.marginXS, flex: 1, minWidth: 240 }}
            >
              <Flex gap={8}>
                <Input
                  id={ids.refId}
                  value={refId}
                  disabled={locked}
                  autoComplete="off"
                  style={code}
                  onChange={(event) => {
                    setRefId(event.target.value);
                    setAddError(undefined);
                  }}
                  onPressEnter={addRef}
                />
                <Button
                  icon={<PlusOutlined aria-hidden />}
                  autoInsertSpace={false}
                  disabled={locked}
                  onClick={addRef}
                >
                  {w.addRef}
                </Button>
              </Flex>
            </Form.Item>
          </Flex>
          <Flex vertical gap={4} style={item}>
            {draft.refs.length === 0 ? (
              <Typography.Text type="secondary">{w.noRefs}</Typography.Text>
            ) : (
              <Table<Ref>
                size="small"
                pagination={false}
                rowKey={(ref) => `${ref.ref_type}:${ref.ref_id}`}
                dataSource={[...draft.refs]}
                columns={[
                  {
                    key: 'type',
                    title: w.refColumns.type,
                    render: (_, ref) => refTypeLabel(ref.ref_type),
                  },
                  {
                    key: 'id',
                    title: w.refColumns.id,
                    render: (_, ref) => <span style={code}>{ref.ref_id}</span>,
                  },
                  {
                    key: 'actions',
                    title: w.refColumns.actions,
                    width: 80,
                    render: (_, ref, index) => (
                      <Button
                        type="link"
                        size="small"
                        danger
                        disabled={locked}
                        icon={<DeleteOutlined aria-hidden />}
                        aria-label={`${w.removeRef} ${refTypeLabel(ref.ref_type)} ${ref.ref_id}`}
                        onClick={() => removeRef(index)}
                      />
                    ),
                  },
                ]}
              />
            )}
            {errors.refs === undefined ? null : (
              <Typography.Text type="danger">{errors.refs}</Typography.Text>
            )}
            {draft.reason === 'OTHER' ? (
              <Typography.Text type="secondary">{w.otherRefsHint}</Typography.Text>
            ) : null}
          </Flex>
          <Form.Item label={l.note} htmlFor={ids.note} {...feedback(errors.note)} style={item}>
            <Input.TextArea
              id={ids.note}
              value={draft.note}
              disabled={locked}
              autoSize={{ minRows: 3, maxRows: 8 }}
              onChange={(event) => change({ note: event.target.value })}
            />
          </Form.Item>
          {subjectShown ? (
            <Form.Item
              label={l.subject}
              htmlFor={ids.subject}
              {...feedback(errors.subject)}
              style={item}
            >
              <Select<ChoosableSubject>
                id={ids.subject}
                value={draft.subject ?? null}
                disabled={locked}
                virtual={false}
                style={{ width: 240 }}
                options={CHOOSABLE_SUBJECTS.map((value) => ({
                  value,
                  label: adjustmentsTexts.subject[value],
                }))}
                onChange={(value: ChoosableSubject) => change({ subject: value })}
              />
            </Form.Item>
          ) : null}
          {draft.reason === 'PAYOUT_RECOVERY' ? (
            <Typography.Paragraph type="secondary" style={item}>
              {w.payoutSubjectHint}
            </Typography.Paragraph>
          ) : null}
          {platformShown ? (
            <Form.Item
              label={l.platform}
              htmlFor={ids.platform}
              {...feedback(errors.platform)}
              style={item}
            >
              <Select<PlatformCode>
                id={ids.platform}
                value={draft.platform ?? null}
                disabled={locked}
                virtual={false}
                style={{ width: 240 }}
                options={PLATFORMS.map((value) => ({
                  value,
                  label: adjustmentsTexts.platform[value],
                }))}
                onChange={(value: PlatformCode) => change({ platform: value })}
              />
            </Form.Item>
          ) : null}
        </Form>
        {preview === undefined ? null : <Typography.Text strong>{preview}</Typography.Text>}
        {write.phoneMissing ? (
          <div id={ids.phone}>
            <Alert type="warning" showIcon message={stepUpTexts.verifyPhoneMissing} />
          </div>
        ) : null}
        {locked ? <Alert type="warning" showIcon message={w.unknown} /> : null}
        {writeError === undefined ? null : <Alert type="error" showIcon message={writeError} />}
      </Flex>
      {write.stepUp}
    </Drawer>
  );
}
