// AI 助手记录（资源 agent-traces，菜单 风控与 AI / AI 助手记录；规划/05 F1-10k 的 D1 页面，F1-10ka；
// 契约 CT-24zzi）：两个页签「会话留痕」（GET /admin/v1/agent-traces/sessions）与「AI 举报」
// （GET …/reports，【标记已处理】POST …/reports/{message_id}/handle）。两张列表与留痕明细都要
// agent.trace，没有时页签说明无权限、不发请求；【标记已处理】另要 agent.report。留痕明细
// GET …/sessions/{session_id} 每读一次服务端记一条 agent_trace_view 审计，所以只在用户点【查看留痕】
// 时读一次：不预取，不随重渲染、切页签、刷新列表重读，关闭再打开才再读。工作台卡
// （/agent/reports?overdue=true）打开本页的 AI 举报页签并带上超时筛选。四个接口用 usePlanned 声明。
// TODO(规划/11 §7): 工具开关只读状态与跳转、举报理由枚举、badcase 手动标记 — blocked on 不在 D1 四个接口内（F-ADM-19 上线后一月内）
import { useDataProvider } from '@refinedev/core';
import { Alert, Card, Flex, Result, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { PlannedPanel, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { agentTracesTexts as t } from '../../texts/agent-traces.ts';
import { codeOf, sessionUrl, type SessionDetail } from './model.ts';
import { ReportsTab } from './ReportsTab.tsx';
import { SessionsTab } from './SessionsTab.tsx';
import { TraceDrawer, type TraceState } from './TraceDrawer.tsx';

export type AgentTracesTab = 'sessions' | 'reports';

export interface AgentTracesPageProps {
  readonly access: AccessControl;
  /** The tab opened first (the workbench card opens 「AI 举报」). */
  readonly initialTab?: AgentTracesTab;
  /** Start the report list with the overdue filter on (?overdue=true of the card's address). */
  readonly initialOverdue?: boolean;
}

/** One opening of a session's trace (`seq` tells openings apart; a late answer of an old one is dropped). */
interface TraceTarget {
  readonly sessionId: string;
  readonly seq: number;
  readonly state: TraceState;
}

function Forbidden(): ReactElement {
  return (
    <Card>
      <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
    </Card>
  );
}

export function AgentTracesPage({
  access,
  initialTab = 'sessions',
  initialOverdue = false,
}: AgentTracesPageProps): ReactElement {
  const sessionsPlanned = usePlanned('adminListAgentSessions');
  const reportsPlanned = usePlanned('adminListAgentReports');
  const tracePlanned = usePlanned('adminGetAgentSession');
  const handlePlanned = usePlanned('adminHandleAgentReport');
  const canRead = access.can('agent.trace');
  const canHandle = access.can('agent.report');
  const getProvider = useDataProvider();
  const [tab, setTab] = useState<AgentTracesTab>(initialTab);
  const [trace, setTrace] = useState<TraceTarget>();
  const traceSeq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The only read of a trace: sent from the operator's click, once per opening.
  const openTrace = useCallback(
    (sessionId: string) => {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      traceSeq.current += 1;
      const seq = traceSeq.current;
      setTrace({ sessionId, seq, state: { status: 'loading' } });
      const settle = (state: TraceState) => {
        if (!alive.current || traceSeq.current !== seq) return;
        setTrace((previous) => (previous?.seq === seq ? { ...previous, state } : previous));
      };
      custom<SessionDetail>({ url: sessionUrl(sessionId), method: 'get' }).then(
        (response) => settle({ status: 'ready', data: response.data }),
        (cause: unknown) => {
          const code = codeOf(cause);
          settle({
            status: code === 20001 ? 'missing' : code === 10403 ? 'forbidden' : 'failed',
          });
        },
      );
    },
    [getProvider],
  );

  const closeTrace = useCallback(() => {
    traceSeq.current += 1;
    setTrace(undefined);
  }, []);

  const sessionsPane = !canRead ? (
    <Forbidden />
  ) : sessionsPlanned ? (
    <PlannedPanel />
  ) : (
    <SessionsTab tracePlanned={tracePlanned} onOpenTrace={openTrace} />
  );
  const reportsPane = !canRead ? (
    <Forbidden />
  ) : reportsPlanned ? (
    <PlannedPanel />
  ) : (
    <ReportsTab
      initialOverdue={initialOverdue}
      canHandle={canHandle}
      handlePlanned={handlePlanned}
      tracePlanned={tracePlanned}
      onOpenTrace={openTrace}
    />
  );

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Alert type="info" showIcon role="note" message={t.pendingNotice} />
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key === 'reports' ? 'reports' : 'sessions')}
        items={[
          { key: 'sessions', label: t.tabs.sessions, children: sessionsPane },
          { key: 'reports', label: t.tabs.reports, children: reportsPane },
        ]}
      />
      {trace === undefined ? null : (
        <TraceDrawer
          key={trace.seq}
          sessionId={trace.sessionId}
          state={trace.state}
          onClose={closeTrace}
        />
      )}
    </Flex>
  );
}
