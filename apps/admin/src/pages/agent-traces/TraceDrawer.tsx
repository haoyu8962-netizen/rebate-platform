// 会话留痕明细抽屉（adminGetAgentSession）：只显示服务端给的内容——消息为存的脱敏文本（null 一律显示
// 中性占位「无文本」；注销清除的条件句说明只在会话 user_id 为 null 且有空文本时出现）、角色、反馈与 badcase、举报时间 / 理由 / 状态 / 处理说明；run 的意图、模型、prompt 版本、
// 输入 / 输出 token（各自标注）、成本（整数毫分）、耗时、结束原因、输出过滤命中；工具调用（参数为存的
// 脱敏形式）；卡片类型与降级文本。请求由页面在用户点开时发一次，这里不发请求。
import {
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Result,
  Tag,
  Typography,
  theme,
} from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { agentTracesTexts } from '../../texts/agent-traces.ts';
import {
  argsText,
  beijingTime,
  type SessionDetail,
  type TraceCard,
  type TraceMessage,
  type TraceRun,
  type TraceToolCall,
} from './model.ts';

const t = agentTracesTexts.trace;
const dash = agentTracesTexts.dash;

export type TraceState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: SessionDetail }
  | { readonly status: 'missing' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'failed' };

export interface TraceDrawerProps {
  readonly sessionId: string;
  readonly state: TraceState;
  readonly onClose: () => void;
}

function orDash(value: string | number | null): ReactNode {
  return value === null ? dash : String(value);
}

function ms(value: number | null): ReactNode {
  return value === null ? dash : `${value} ${t.run.ms}`;
}

function MessageItem({ message }: { readonly message: TraceMessage }): ReactElement {
  const reported = message.report_status !== null || message.reported_at !== null;
  return (
    <Card size="small">
      <Flex vertical gap={6}>
        <Flex gap={8} wrap align="center">
          <Typography.Text strong>{t.roles[message.role]}</Typography.Text>
          {message.feedback === null ? null : (
            <Tag color={message.feedback === 'down' ? 'warning' : 'success'}>
              {t.feedback[message.feedback]}
            </Tag>
          )}
          {message.badcase ? <Tag color="error">{t.badcase}</Tag> : null}
          {message.card_ids.length > 0 ? (
            <Typography.Text type="secondary">{t.cards(message.card_ids)}</Typography.Text>
          ) : null}
        </Flex>
        {message.text === null ? (
          <Typography.Text type="secondary">{t.textGone}</Typography.Text>
        ) : (
          <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
            {message.text}
          </Typography.Paragraph>
        )}
        {reported ? (
          <Flex gap={8} wrap align="center">
            {message.report_status === null ? null : (
              <Tag color={message.report_status === 'pending' ? 'processing' : 'default'}>
                {agentTracesTexts.reports.statuses[message.report_status]}
              </Tag>
            )}
            {message.reported_at === null ? null : (
              <Typography.Text type="secondary">
                {t.reportedAt(beijingTime(message.reported_at))}
              </Typography.Text>
            )}
            {message.report_reason === null ? null : (
              <Typography.Text>{t.reportReason(message.report_reason)}</Typography.Text>
            )}
            {message.report_note === null ? null : (
              <Typography.Text>{t.reportNote(message.report_note)}</Typography.Text>
            )}
          </Flex>
        ) : null}
      </Flex>
    </Card>
  );
}

function RunItem({ run }: { readonly run: TraceRun }): ReactElement {
  const r = t.run;
  return (
    <Descriptions
      size="small"
      bordered
      column={2}
      title={<Typography.Text code>{run.run_id}</Typography.Text>}
      items={[
        { key: 'intent', label: r.intent, children: orDash(run.intent) },
        { key: 'finish', label: r.finish, children: orDash(run.finish_reason) },
        { key: 'model', label: r.model, children: orDash(run.model) },
        { key: 'snapshot', label: r.snapshot, children: orDash(run.model_snapshot) },
        { key: 'prompt', label: r.prompt, children: run.prompt_version },
        {
          key: 'cost',
          label: r.cost,
          children: run.cost_mfen === null ? dash : `${run.cost_mfen} ${r.costUnit}`,
        },
        { key: 'input', label: r.inputTokens, children: orDash(run.input_tokens) },
        { key: 'output', label: r.outputTokens, children: orDash(run.output_tokens) },
        { key: 'ttft', label: r.ttft, children: ms(run.ttft_ms) },
        { key: 'latency', label: r.latency, children: ms(run.latency_ms) },
        {
          key: 'filters',
          label: r.filters,
          span: 2,
          children:
            run.filter_hits.length === 0 ? (
              r.none
            ) : (
              <Flex gap={4} wrap>
                {run.filter_hits.map((hit) => (
                  <Tag key={hit}>{hit}</Tag>
                ))}
              </Flex>
            ),
        },
        { key: 'accepted', label: r.acceptedAt, children: beijingTime(run.accepted_at) },
        {
          key: 'ended',
          label: r.endedAt,
          children: run.ended_at === null ? dash : beijingTime(run.ended_at),
        },
      ]}
    />
  );
}

function ToolItem({ call }: { readonly call: TraceToolCall }): ReactElement {
  const r = t.tool;
  const args = argsText(call.args);
  return (
    <Descriptions
      size="small"
      bordered
      column={2}
      items={[
        {
          key: 'name',
          label: r.name,
          children: <Typography.Text code>{call.name}</Typography.Text>,
        },
        { key: 'status', label: r.status, children: call.status },
        { key: 'run', label: r.run, children: call.run_id },
        { key: 'seq', label: r.seq, children: String(call.seq) },
        { key: 'latency', label: r.latency, children: ms(call.latency_ms) },
        {
          key: 'args',
          label: r.args,
          children:
            args === undefined ? (
              dash
            ) : (
              <Typography.Text code style={{ wordBreak: 'break-all' }}>
                {args}
              </Typography.Text>
            ),
        },
      ]}
    />
  );
}

function CardItem({ card }: { readonly card: TraceCard }): ReactElement {
  const r = t.card;
  return (
    <Descriptions
      size="small"
      bordered
      column={1}
      items={[
        { key: 'id', label: r.id, children: card.card_id },
        { key: 'type', label: r.type, children: card.type },
        { key: 'fallback', label: r.fallback, children: card.fallback_text },
      ]}
    />
  );
}

function Section({
  title,
  empty,
  note,
  children,
}: {
  readonly title: string;
  readonly empty: string;
  readonly note?: string | undefined;
  readonly children: readonly ReactElement[];
}): ReactElement {
  return (
    <Flex vertical gap={8}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      {note === undefined ? null : <Typography.Text type="secondary">{note}</Typography.Text>}
      {children.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />
      ) : (
        children
      )}
    </Flex>
  );
}

function TraceBody({ data }: { readonly data: SessionDetail }): ReactElement {
  const s = agentTracesTexts.sessions;
  // 注销清除只可能发生在 user_id 已被置空的会话里；user_id 为空也可能是访客，所以只写条件句。
  const gapNote =
    data.user_id === null && data.messages.some((message) => message.text === null)
      ? t.textGoneNote
      : undefined;
  return (
    <Flex vertical gap={16}>
      <Descriptions
        size="small"
        bordered
        column={1}
        items={[
          { key: 'session', label: t.session, children: data.session_id },
          { key: 'user', label: t.user, children: data.user_id ?? agentTracesTexts.guest },
          { key: 'started', label: t.startedAt, children: beijingTime(data.started_at) },
          { key: 'active', label: t.lastActiveAt, children: beijingTime(data.last_active_at) },
          { key: 'expired', label: t.expired, children: data.expired ? s.expired : s.live },
        ]}
      />
      <Section title={t.messages} empty={t.noMessages} note={gapNote}>
        {data.messages.map((message) => (
          <MessageItem key={message.message_id} message={message} />
        ))}
      </Section>
      <Section title={t.runs} empty={t.noRuns}>
        {data.runs.map((run) => (
          <RunItem key={run.run_id} run={run} />
        ))}
      </Section>
      <Section title={t.tools} empty={t.noTools}>
        {data.tool_calls.map((call) => (
          <ToolItem key={`${call.run_id}-${call.seq}`} call={call} />
        ))}
      </Section>
      <Section title={t.cardList} empty={t.noCards}>
        {data.cards.map((card) => (
          <CardItem key={card.card_id} card={card} />
        ))}
      </Section>
    </Flex>
  );
}

export function TraceDrawer({ sessionId, state, onClose }: TraceDrawerProps): ReactElement {
  const { token } = theme.useToken();
  let body: ReactElement;
  if (state.status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else if (state.status === 'missing') {
    body = <Result status="404" title={t.missingTitle} subTitle={t.missingDescription} />;
  } else if (state.status === 'forbidden') {
    body = (
      <Result
        status="403"
        title={t.forbiddenTitle}
        subTitle={agentTracesTexts.forbiddenDescription}
      />
    );
  } else if (state.status === 'failed') {
    body = <Result status="error" title={t.failedTitle} subTitle={t.failedDescription} />;
  } else {
    body = <TraceBody data={state.data} />;
  }
  return (
    <Drawer
      open
      width={720}
      destroyOnHidden
      title={
        <span style={{ fontFamily: token.fontFamilyCode, wordBreak: 'break-all' }}>
          {t.title(sessionId)}
        </span>
      }
      onClose={onClose}
      footer={
        <Flex justify="end">
          <Button onClick={onClose}>{t.close}</Button>
        </Flex>
      }
    >
      {body}
    </Drawer>
  );
}
