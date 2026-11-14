// 调账与核销（资源 adjustments，菜单 资金 / 调账与核销；F1-08ca 只读）：页签「调账单」（fund.adjust 或
// fund.view，adminListAdjustments + adminGetAdjustment）与「坏账核销」（fund.writeoff 或 fund.view，
// adminListBadDebtWriteoffs），缺读权限点的页签不出现；三个读权限点都没有时本页说明无权限、不发请求。
// 菜单仍按 resources（fund.adjust 或 fund.writeoff），fund.view 经直达地址只读。
// TODO(规划/11 §7): 新建调账与红冲（F1-08cb）、批准 / 驳回系统预填单（F1-08cc）、批准核销（F1-08cd） — blocked on 后续任务
import { Alert, Card, Flex, Result, Tabs, Typography } from 'antd';
import type { ReactElement } from 'react';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { adjustmentsTexts as t } from '../../texts/adjustments.ts';
import { AdjustmentsTab } from './AdjustmentsTab.tsx';
import { canReadAdjustments, canReadWriteoffs } from './model.ts';
import { WriteoffsTab } from './WriteoffsTab.tsx';

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
  if (planned) return <PlannedPage title={t.title} />;
  const readsAdjustments = canReadAdjustments(access);
  const readsWriteoffs = canReadWriteoffs(access);
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
      ? [{ key: 'adjustments', label: t.tabs.adjustments, children: <AdjustmentsTab /> }]
      : []),
    ...(readsWriteoffs
      ? [{ key: 'writeoffs', label: t.tabs.writeoffs, children: <WriteoffsTab /> }]
      : []),
  ];
  return (
    <Flex vertical gap={16}>
      <Title />
      <Alert type="info" showIcon role="note" message={t.readOnlyNotice} />
      <Tabs items={items} />
    </Flex>
  );
}
