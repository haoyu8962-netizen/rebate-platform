// 调账与核销（资源 adjustments，菜单 资金 / 调账与核销；F1-08ca 只读）：页签「调账单」（fund.adjust 或
// fund.view，adminListAdjustments + adminGetAdjustment）与「坏账核销」（fund.writeoff 或 fund.view，
// adminListBadDebtWriteoffs），缺读权限点的页签不出现；三个读权限点都没有时本页说明无权限、不发请求。
// 菜单仍按 resources（fund.adjust 或 fund.writeoff），fund.view 经直达地址只读。
// 持 fund.adjust（超管含）时标题行有【新建调账】（F1-08cb，CreateDrawer），行与详情有【红冲】；两者都走
// adminCreateAdjustment 一步提交并生效，成功后在标题下提示新单号与前后可用余额并刷新调账单列表。
// 新建结果未知时【去列表核对】关抽屉、刷新列表；此后再按【新建调账】先读一次列表，读完才显示空白表单。
// 待批准（系统预填）的行与详情有【批准】（F1-08cc，批准并短信验证 / 驳回），结果提示同样在标题下。
// 持 fund.writeoff（超管含）时坏账核销待批准的行有【批准核销】（F1-08cd，短信验证），结果提示同样在标题下。
// F1-08fe：记了凭证的成功提示（新建、红冲、已核销）有【查看凭证】，跳余额流水并预填该用户与凭证 biz_id；
// 从余额流水「关联单据」进来时按路由状态先打开该调账单详情或「坏账核销」页签（只是起始视图，不另发读）。
import { PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Result, Tabs, Typography } from 'antd';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Link, useLocation } from 'react-router';
import { PlannedPage, plannedButtonProps, usePlanned } from '../../components/planned/index.ts';
import { UnknownMarkerBanner, useMarkerAccount } from '../../components/unknown-marker/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { adjustmentsTexts as t } from '../../texts/adjustments.ts';
import { AdjustmentsTab, type Notice } from './AdjustmentsTab.tsx';
import { CreateDrawer } from './CreateDrawer.tsx';
import { openingOf, voucherOf } from './links.ts';
import { canReadAdjustments, canReadWriteoffs, money } from './model.ts';
import { WriteoffsTab } from './WriteoffsTab.tsx';
import type { Executed } from './write.ts';
import { ledgerRoute } from '../ledger/prefill.ts';

/** The result-unknown marker's page (F1-08at): the menu id of 调账与核销 (see useAdjustmentWrite). */
const MARKER_PAGE = 'adjustments';

export interface AdjustmentsPageProps {
  readonly access: AccessControl;
}

function Title(): ReactElement {
  return (
    <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
      {t.title}
    </Typography.Title>
  );
}

export function AdjustmentsPage({ access }: AdjustmentsPageProps): ReactElement {
  const planned = usePlanned('adminListAdjustments');
  const writePlanned = usePlanned('adminCreateAdjustment');
  const location = useLocation();
  /** Where another page asked to open (read once: later navigation within the page is its own). */
  const [opening] = useState(() => openingOf(location.state));
  const entryRef = useRef<HTMLButtonElement>(null);
  /** Every opening of the drawer is a new form (and a new Idempotency-Key). */
  const [createSession, setCreateSession] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  /** Bumped after every write: the 调账单 list and an open detail are read again. */
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<Notice>();
  /** After 【去列表核对】: the next opening reads the list first. */
  const [recheck, setRecheck] = useState(false);
  /** The opening waits for the list read of this version (undefined: none waits). */
  const [waitingFor, setWaitingFor] = useState<number>();
  // F1-08at: the account whose result-unknown marker of this page is shown on top.
  const account = useMarkerAccount();
  const listRead = useCallback(
    (read: number) => {
      if (waitingFor === undefined || read < waitingFor) return;
      setWaitingFor(undefined);
      setCreateOpen(true);
    },
    [waitingFor],
  );
  if (planned) return <PlannedPage title={t.title} />;
  const readsAdjustments = canReadAdjustments(access);
  const readsWriteoffs = canReadWriteoffs(access);
  const canAdjust = access.can('fund.adjust');

  const openCreate = () => {
    if (waitingFor !== undefined) return;
    setCreateSession((value) => value + 1);
    if (!recheck) {
      setCreateOpen(true);
      return;
    }
    setRecheck(false);
    setWaitingFor(version + 1);
    setVersion(version + 1);
  };
  const cancelCreate = () => {
    setCreateOpen(false);
    entryRef.current?.focus();
  };
  const created = (executed: Executed) => {
    setCreateOpen(false);
    setNotice({
      type: 'success',
      lines: [
        t.write.created(executed.adjustment.adjust_id),
        t.write.createdBefore(money(executed.available_before_fen)),
        t.write.createdAfter(money(executed.available_after_fen)),
      ],
      voucher: voucherOf(executed),
    });
    setVersion((value) => value + 1);
  };
  /** 【去列表核对】 of a new adjustment whose result is unknown. */
  const checkCreate = () => {
    cancelCreate();
    setRecheck(true);
    setVersion((value) => value + 1);
  };
  if (!readsAdjustments && !readsWriteoffs) {
    return (
      <Flex vertical gap={16}>
        <Title />
        <Card>
          <Result status="403" title={t.forbidden} subTitle={t.forbiddenDescription} />
        </Card>
      </Flex>
    );
  }
  const items = [
    ...(readsAdjustments
      ? [
          {
            key: 'adjustments',
            label: t.tabs.adjustments,
            children: (
              <AdjustmentsTab
                canAdjust={canAdjust}
                planned={writePlanned}
                version={version}
                {...(opening.detail === undefined ? {} : { initialDetail: opening.detail })}
                onNotice={setNotice}
                onListRead={listRead}
              />
            ),
          },
        ]
      : []),
    ...(readsWriteoffs
      ? [
          {
            key: 'writeoffs',
            label: t.tabs.writeoffs,
            children: (
              <WriteoffsTab canWriteoff={access.can('fund.writeoff')} onNotice={setNotice} />
            ),
          },
        ]
      : []),
  ];
  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between" gap={16} wrap>
        <Title />
        {canAdjust ? (
          <Button
            ref={entryRef}
            type="primary"
            icon={<PlusOutlined aria-hidden />}
            autoInsertSpace={false}
            {...plannedButtonProps(writePlanned)}
            onClick={openCreate}
          >
            {t.write.createEntry}
          </Button>
        ) : null}
      </Flex>
      <UnknownMarkerBanner scope={{ page: MARKER_PAGE, account }} />
      <Alert type="info" showIcon role="note" message={t.readOnlyNotice} />
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          message={
            <div>
              {notice.lines.map((line, index) => (
                <div key={index}>{line}</div>
              ))}
            </div>
          }
          action={
            notice.voucher === undefined ? undefined : (
              <Link to={ledgerRoute(notice.voucher)}>{t.write.viewVoucher}</Link>
            )
          }
          onClose={() => setNotice(undefined)}
        />
      )}
      <Tabs
        items={items}
        {...(opening.tab !== undefined && items.some((item) => item.key === opening.tab)
          ? { defaultActiveKey: opening.tab }
          : {})}
      />
      {canAdjust ? (
        <CreateDrawer
          key={createSession}
          open={createOpen}
          planned={writePlanned}
          onClose={cancelCreate}
          onCreated={created}
          onCheck={checkCreate}
        />
      ) : null}
    </Flex>
  );
}
