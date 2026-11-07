// Editor view of the home page configuration (design-hifi AdmHomeConfig): page selector, status
// tags, the read-only block list (type, id, audience) on the left and the whole-page sections
// JSON on the right. Only the JSON text is edited; there is no form, drag, add or local preview.
// The preview token panel shows page_key, token, the Beijing expiry and a QR code of the App's
// HomePreview deep link for this token (drawn as SVG, no icon).
import { HistoryOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Flex, Input, QRCode, Select, Tag, Typography, theme } from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { homeConfigTexts as t } from '../../texts/home-config.ts';
import {
  beijingTime,
  pageOptionLabel,
  previewDeepLink,
  type BlockSummary,
  type PageConfig,
  type PreviewToken,
  type VersionSummary,
} from './model.ts';

export interface EditorViewProps {
  readonly pageKeys: readonly string[];
  readonly pageKey: string;
  readonly page: PageConfig | null;
  readonly latest: VersionSummary | null;
  readonly text: string;
  readonly blocks: readonly BlockSummary[];
  readonly blocksStale: boolean;
  readonly basedOn: number | null;
  readonly preview: PreviewToken | null;
  readonly busy: boolean;
  readonly switching: boolean;
  readonly notice: ReactNode;
  readonly onSelectPage: (key: string) => void;
  readonly onText: (text: string) => void;
  readonly onSave: () => void;
  readonly onPublish: () => void;
  readonly onPreview: () => void;
  readonly onHistory: () => void;
}

export function EditorView(props: EditorViewProps): ReactElement {
  const { token } = theme.useToken();
  const { page, latest } = props;
  const small = { fontSize: 12 } as const;
  const code = { fontFamily: token.fontFamilyCode, fontSize: 12 } as const;
  const card = { boxShadow: token.boxShadowTertiary } as const;
  const locked = props.busy || props.switching;

  const latestNumber = page?.latest_version ?? null;
  const publishable =
    page !== null &&
    latest !== null &&
    latest.status === 'draft' &&
    latest.version === latestNumber &&
    page.gray_version === null;
  let publishNote: string | null = null;
  if (page !== null && page.gray_version !== null)
    publishNote = t.publish.blockedByGray(page.gray_version);
  else if (page !== null && latest !== null && latest.status !== 'draft')
    publishNote = t.publish.notDraft;

  const tags: ReactNode[] = [];
  if (latestNumber !== null)
    tags.push(
      <Tag key="latest" color={latest?.status === 'draft' ? 'default' : 'processing'}>
        {latest?.status === 'draft' ? t.tags.draft(latestNumber) : t.tags.latest(latestNumber)}
      </Tag>,
    );
  if (page !== null) {
    tags.push(
      <Tag key="current" color={page.current_version === null ? 'default' : 'success'}>
        {page.current_version === null ? t.tags.noCurrent : t.tags.current(page.current_version)}
      </Tag>,
      <Tag key="grayTag" color={page.gray_version === null ? 'default' : 'warning'}>
        {page.gray_version === null
          ? t.tags.noGray
          : t.tags.gray(page.gray_version, page.gray_percent)}
      </Tag>,
    );
  }

  const options = props.pageKeys.map((key) => ({ value: key, label: pageOptionLabel(key) }));

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" gap={16} wrap>
        <Flex align="center" gap={12} wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.title}
          </Typography.Title>
          <Flex gap={4} wrap>
            {tags}
          </Flex>
        </Flex>
        <Flex gap={8} wrap>
          <Button
            icon={<HistoryOutlined aria-hidden />}
            disabled={props.switching}
            onClick={props.onHistory}
          >
            {t.actions.history}
          </Button>
          <Button disabled={locked || latestNumber === null} onClick={props.onPreview}>
            {t.actions.preview}
          </Button>
          <Button disabled={locked} onClick={props.onSave}>
            {t.actions.save}
          </Button>
          <Button type="primary" disabled={locked || !publishable} onClick={props.onPublish}>
            {t.actions.publish}
          </Button>
        </Flex>
      </Flex>
      <Flex vertical gap={4}>
        <Typography.Text type="secondary" style={small}>
          {t.pageLabel}
        </Typography.Text>
        <Flex align="center" gap={16} wrap>
          <Select<string>
            aria-label={t.pageLabel}
            value={props.pageKey}
            options={options}
            virtual={false}
            disabled={locked}
            onChange={props.onSelectPage}
            style={{ width: 200 }}
          />
          <Typography.Text type="secondary" style={small}>
            {page === null || page.updated_at === null
              ? t.neverSaved
              : t.lastSaved(page.updated_by ?? t.systemActor, beijingTime(page.updated_at))}
          </Typography.Text>
        </Flex>
      </Flex>
      {props.notice}
      {page === null ? (
        <Card style={card}>
          <Empty description={t.empty} />
        </Card>
      ) : null}
      {publishNote === null ? null : (
        <Typography.Text type="secondary" style={small}>
          {publishNote}
        </Typography.Text>
      )}
      {props.preview === null ? null : (
        <Card style={card} title={t.preview.title(props.preview.version)} size="small">
          <Flex vertical gap={8}>
            <Flex gap={24} wrap>
              <Flex vertical gap={2}>
                <Typography.Text type="secondary" style={small}>
                  {t.preview.page}
                </Typography.Text>
                <Typography.Text style={code}>{props.preview.page_key}</Typography.Text>
              </Flex>
              <Flex vertical gap={2}>
                <Typography.Text type="secondary" style={small}>
                  {t.preview.token}
                </Typography.Text>
                <Typography.Text style={{ ...code, overflowWrap: 'anywhere' }}>
                  {props.preview.token}
                </Typography.Text>
              </Flex>
              <Flex vertical gap={2}>
                <Typography.Text type="secondary" style={small}>
                  {t.preview.expire}
                </Typography.Text>
                <Typography.Text>
                  {t.preview.expireAt(beijingTime(props.preview.expire_at))}
                </Typography.Text>
              </Flex>
            </Flex>
            <Flex align="center" gap={16} wrap>
              <div
                role="img"
                aria-label={t.preview.qrLabel(props.preview.page_key, props.preview.version)}
                style={{ flex: 'none' }}
              >
                <QRCode
                  value={previewDeepLink(props.preview)}
                  type="svg"
                  errorLevel="M"
                  size={160}
                  aria-hidden="true"
                />
              </div>
              <Typography.Text type="secondary" style={small}>
                {t.preview.qr}
              </Typography.Text>
            </Flex>
            <Typography.Text type="secondary" style={small}>
              {t.preview.savedOnly}
            </Typography.Text>
          </Flex>
        </Card>
      )}
      <Flex gap={16} align="flex-start">
        <Card
          style={{ ...card, width: 280, flex: 'none' }}
          title={t.blocks.title(props.blocks.length)}
          styles={{ body: { padding: 12 } }}
        >
          <Flex vertical gap={8}>
            {props.blocks.length === 0 ? (
              <Typography.Text type="secondary">{t.blocks.empty}</Typography.Text>
            ) : (
              props.blocks.map((block) => (
                <Flex
                  key={block.key}
                  vertical
                  gap={4}
                  style={{
                    padding: 12,
                    borderRadius: token.borderRadius,
                    border: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <Typography.Text style={{ ...code, overflowWrap: 'anywhere' }}>
                    {block.type}
                    {t.blocks.separator}
                    {block.id}
                  </Typography.Text>
                  <span>
                    <Tag
                      color={block.everyone ? 'default' : 'processing'}
                      style={{ marginInlineEnd: 0, whiteSpace: 'normal' }}
                    >
                      {block.audience}
                    </Tag>
                  </span>
                </Flex>
              ))
            )}
            {props.blocksStale ? (
              <Typography.Text type="warning" style={small}>
                {t.blocks.stale}
              </Typography.Text>
            ) : null}
            <Typography.Text type="secondary" style={small}>
              {t.blocks.note}
            </Typography.Text>
          </Flex>
        </Card>
        <Card
          style={{ ...card, flex: 1, minWidth: 0 }}
          title={t.editor.title}
          extra={
            props.basedOn === null ? null : (
              <Typography.Text type="secondary" style={small}>
                {t.editor.basedOn(props.basedOn)}
              </Typography.Text>
            )
          }
        >
          <Flex vertical gap={8}>
            <Typography.Text type="secondary" style={small}>
              {t.editor.hint}
            </Typography.Text>
            <Input.TextArea
              aria-label={t.editor.label}
              value={props.text}
              spellCheck={false}
              autoSize={{ minRows: 16, maxRows: 32 }}
              readOnly={props.switching}
              onChange={(event) => props.onText(event.target.value)}
              style={code}
            />
          </Flex>
        </Card>
      </Flex>
    </Flex>
  );
}
