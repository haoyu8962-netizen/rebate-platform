// Home page configuration (design-hifi AdmHomeConfig, AdmHomeConfigPublish, AdmHomeConfigVersions;
// /admin/v1/pages*, permission point content.page, no step-up). Reads the page list, picks home
// (else the first page), then the page detail and its newest saved version, whose sections fill
// the JSON editor. Every page write (save draft, publish, gray, rollback) carries the page's
// `expected_revision` as last read; one write at a time, and after it the detail is read again so
// the next write uses the new revision. 20902 → re-read, the editor text is kept, nothing is
// resent; an unknown result (network, unreadable answer, 5xxxx) is reported and re-read, never
// resent; 20001 lists `data.fields` path by path. All requests go through the data provider.
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Card, Flex, Result, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { homeConfigTexts as t } from '../../texts/home-config.ts';
import { EditorView } from './EditorView.tsx';
import { HistoryView, type VersionDetailState, type VersionsState } from './HistoryView.tsx';
import { ConfirmActionModal, GrayModal, PublishModal } from './Modals.tsx';
import {
  LIST_PAGE_SIZE,
  LIST_URL,
  VERSIONS_PAGE_SIZE,
  actionUrl,
  codeOf,
  defaultPageKey,
  fieldsOf,
  parseSections,
  sectionsText,
  serverMessage,
  summarize,
  versionUrl,
  versionsUrl,
  pageUrl,
  writeOutcomeUnknown,
  type BlockSummary,
  type PageConfig,
  type PageList,
  type PageVersion,
  type PreviewToken,
  type Section,
  type VersionList,
  type VersionSummary,
} from './model.ts';

export interface HomeConfigPageProps {
  readonly access: AccessControl;
}

type Status = 'loading' | 'ready' | 'failed' | 'forbidden';

type Dialog =
  | { readonly kind: 'publish'; readonly version: number }
  | { readonly kind: 'adjust' }
  | { readonly kind: 'full' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'rollback'; readonly version: number };

type WriteOp =
  | { readonly kind: 'save'; readonly sections: Section[] }
  | { readonly kind: 'publish'; readonly version: number; readonly percent: number }
  | { readonly kind: 'adjust'; readonly version: number; readonly percent: number }
  | { readonly kind: 'rollback'; readonly version: number; readonly stop: boolean }
  | { readonly kind: 'preview'; readonly version: number };

interface Notice {
  readonly type: 'success' | 'error' | 'warning' | 'info';
  readonly text: string;
  readonly fields?: readonly string[];
  readonly reload?: boolean;
}

interface PageState {
  readonly page: PageConfig | null;
  readonly latest: PageVersion | null;
}

const EMPTY_VERSIONS: VersionsState = {
  status: 'loading',
  items: [],
  total: 0,
  page: 1,
  pageSize: VERSIONS_PAGE_SIZE,
};

function summaryOf(version: PageVersion | null): VersionSummary | null {
  if (version === null) return null;
  const { page_key, sections, ...summary } = version;
  void page_key;
  void sections;
  return summary;
}

export function HomeConfigPage({ access }: HomeConfigPageProps): ReactElement {
  const allowed = access.can('content.page');
  const getProvider = useDataProvider();
  const [status, setStatus] = useState<Status>(allowed ? 'loading' : 'forbidden');
  const [pageKeys, setPageKeys] = useState<readonly string[]>([]);
  const [pageKey, setPageKey] = useState('');
  const [page, setPage] = useState<PageConfig | null>(null);
  const [latest, setLatest] = useState<VersionSummary | null>(null);
  const [text, setText] = useState('[]');
  const [blocks, setBlocks] = useState<readonly BlockSummary[]>([]);
  const [blocksStale, setBlocksStale] = useState(false);
  const [basedOn, setBasedOn] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [view, setView] = useState<'editor' | 'history'>('editor');
  const [versions, setVersions] = useState<VersionsState>(EMPTY_VERSIONS);
  const [detail, setDetail] = useState<VersionDetailState | null>(null);
  const [dialog, setDialog] = useState<Dialog>();
  const [writing, setWritingState] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [preview, setPreview] = useState<PreviewToken | null>(null);
  const writingRef = useRef(false);
  const loadSequence = useRef(0);
  const versionsSequence = useRef(0);
  const detailSequence = useRef(0);
  const versionsPage = useRef(1);

  const setWriting = useCallback((value: boolean) => {
    writingRef.current = value;
    setWritingState(value);
  }, []);

  const custom = useCallback(() => {
    const call = getProvider().custom;
    if (call === undefined) throw new Error('Missing custom data provider');
    return call;
  }, [getProvider]);

  const applyText = useCallback((next: string) => {
    setText(next);
    const parsed = parseSections(next);
    if (parsed.ok) {
      setBlocks(summarize(parsed.sections));
      setBlocksStale(false);
    } else setBlocksStale(true);
  }, []);

  /** All pages, page by page (page_size ≤ 200) until the server's total. */
  const readList = useCallback(async (): Promise<PageConfig[]> => {
    const collected: PageConfig[] = [];
    for (let number = 1; ; number += 1) {
      const response = await custom()<PageList>({
        url: LIST_URL,
        method: 'get',
        query: { page: number, page_size: LIST_PAGE_SIZE },
      });
      collected.push(...response.data.items);
      if (response.data.items.length === 0 || collected.length >= response.data.total) break;
    }
    return collected;
  }, [custom]);

  /** The page detail and its newest saved version; a page with no saved version (30701) → null. */
  const readPage = useCallback(
    async (key: string): Promise<PageState> => {
      let detailData: PageConfig;
      try {
        detailData = (await custom()<PageConfig>({ url: pageUrl(key), method: 'get' })).data;
      } catch (cause) {
        if (codeOf(cause) === 30701) return { page: null, latest: null };
        throw cause;
      }
      if (detailData.latest_version === null) return { page: detailData, latest: null };
      const version = await custom()<PageVersion>({
        url: versionUrl(key, detailData.latest_version),
        method: 'get',
      });
      return { page: detailData, latest: version.data };
    },
    [custom],
  );

  const applyPage = useCallback(
    (key: string, state: PageState, resetEditor: boolean) => {
      setPage(state.page);
      setLatest(summaryOf(state.latest));
      if (state.page !== null)
        setPageKeys((keys) =>
          keys.includes(key) ? keys : [...keys, key].sort((a, b) => a.localeCompare(b)),
        );
      if (resetEditor) {
        applyText(sectionsText(state.latest?.sections ?? []));
        setBasedOn(state.latest?.version ?? null);
      }
    },
    [applyText],
  );

  /** The page list, the chosen page (preferred if listed, else home, else the first) and it. */
  const fetchAll = useCallback(
    async (
      preferred: string | undefined,
    ): Promise<{ keys: string[]; key: string; state: PageState }> => {
      const list = await readList();
      const keys = list.map((entry) => entry.page_key);
      const key =
        preferred !== undefined && keys.includes(preferred) ? preferred : defaultPageKey(list);
      const state = await readPage(key);
      return { keys: keys.includes(key) ? keys : [key, ...keys], key, state };
    },
    [readList, readPage],
  );

  const loadAll = useCallback(
    (preferred?: string): void => {
      const sequence = ++loadSequence.current;
      void fetchAll(preferred).then(
        ({ keys, key, state }) => {
          if (sequence !== loadSequence.current) return;
          setPageKeys(keys);
          setPageKey(key);
          applyPage(key, state, true);
          setStatus('ready');
        },
        (cause: unknown) => {
          if (sequence !== loadSequence.current) return;
          setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
        },
      );
    },
    [fetchAll, applyPage],
  );

  useEffect(() => {
    if (allowed) loadAll();
    return () => {
      loadSequence.current += 1;
      versionsSequence.current += 1;
      detailSequence.current += 1;
    };
  }, [allowed, loadAll]);

  const loadVersions = useCallback(
    async (key: string, number: number): Promise<void> => {
      const sequence = ++versionsSequence.current;
      versionsPage.current = number;
      setVersions((previous) => ({ ...previous, status: 'loading', page: number }));
      try {
        const response = await custom()<VersionList>({
          url: versionsUrl(key),
          method: 'get',
          query: { page: number, page_size: VERSIONS_PAGE_SIZE },
        });
        if (sequence !== versionsSequence.current) return;
        setVersions({
          status: 'ready',
          items: response.data.items,
          total: response.data.total,
          page: number,
          pageSize: VERSIONS_PAGE_SIZE,
        });
      } catch (cause) {
        if (sequence !== versionsSequence.current) return;
        if (codeOf(cause) === 30701) {
          setVersions({ ...EMPTY_VERSIONS, status: 'ready', page: number });
          return;
        }
        if (codeOf(cause) === 10403) setStatus('forbidden');
        setVersions((previous) => ({ ...previous, status: 'failed' }));
      }
    },
    [custom],
  );

  /** Reads the page again after a write (or its failure); the editor text is kept. */
  const reread = async (key: string): Promise<boolean> => {
    const sequence = ++loadSequence.current;
    const versionsRead = loadVersions(key, versionsPage.current);
    try {
      const state = await readPage(key);
      if (sequence !== loadSequence.current) return true;
      applyPage(key, state, false);
      await versionsRead;
      return true;
    } catch (cause) {
      await versionsRead;
      if (sequence !== loadSequence.current) return true;
      if (codeOf(cause) === 10403) setStatus('forbidden');
      return false;
    }
  };

  const reloadNow = () => {
    if (writingRef.current) return;
    setWriting(true);
    void reread(pageKey).then((ok) => {
      setWriting(false);
      setNotice(ok ? undefined : { type: 'error', text: t.errors.rereadFailed, reload: true });
    });
  };

  const retry = () => {
    setStatus('loading');
    loadAll(pageKey === '' ? undefined : pageKey);
  };

  const selectPage = (key: string) => {
    if (writingRef.current || key === pageKey) return;
    const sequence = ++loadSequence.current;
    setPageKey(key);
    setSwitching(true);
    setNotice(undefined);
    setPreview(null);
    setDetail(null);
    setVersions(EMPTY_VERSIONS);
    void readPage(key).then(
      (state) => {
        if (sequence !== loadSequence.current) return;
        applyPage(key, state, true);
        setSwitching(false);
      },
      (cause: unknown) => {
        if (sequence !== loadSequence.current) return;
        setSwitching(false);
        setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
      },
    );
  };

  const successText = (op: WriteOp, result: unknown): string => {
    switch (op.kind) {
      case 'save':
        return t.success.saved((result as PageVersion).version);
      case 'publish':
        return op.percent === 100
          ? t.success.publishedFull(op.version)
          : t.success.publishedGray(op.version, op.percent);
      case 'adjust':
        return op.percent === 100 ? t.success.full(op.version) : t.success.adjusted(op.percent);
      case 'rollback':
        return op.stop ? t.success.stopped(op.version) : t.success.rolledBack(op.version);
      case 'preview':
        return t.success.preview(op.version);
    }
  };

  const perform = async (op: WriteOp): Promise<void> => {
    if (writingRef.current || status !== 'ready') return;
    const key = pageKey;
    const revision = page?.revision ?? 0;
    setWriting(true);
    setNotice(undefined);
    try {
      let result: unknown;
      if (op.kind === 'save') {
        const response = await custom()<PageVersion>({
          url: versionsUrl(key),
          method: 'post',
          payload: { sections: op.sections, expected_revision: revision },
        });
        result = response.data;
        setBasedOn(response.data.version);
        setLatest(summaryOf(response.data));
      } else if (op.kind === 'preview') {
        // A refused or unknown re-issue must not leave the previous token's QR code on screen.
        setPreview(null);
        const response = await custom()<PreviewToken>({
          url: actionUrl(key, 'preview'),
          method: 'post',
          payload: { version: op.version },
        });
        result = response.data;
        setPreview(response.data);
      } else {
        const payload =
          op.kind === 'publish'
            ? { version: op.version, gray_percent: op.percent, expected_revision: revision }
            : op.kind === 'adjust'
              ? { gray_percent: op.percent, expected_revision: revision }
              : { version: op.version, expected_revision: revision };
        const response = await custom()<PageConfig>({
          url: actionUrl(key, op.kind),
          method: 'post',
          payload,
        });
        result = response.data;
        setPage(response.data);
      }
      setDialog(undefined);
      setNotice({ type: 'success', text: successText(op, result) });
      if (op.kind !== 'preview') {
        const ok = await reread(key);
        if (!ok)
          setNotice({
            type: 'warning',
            text: `${successText(op, result)} ${t.errors.rereadFailed}`,
            reload: true,
          });
      }
    } catch (cause) {
      setDialog(undefined);
      const code = codeOf(cause);
      if (code === 10403) {
        setNotice({ type: 'error', text: t.errors.forbidden });
        setStatus('forbidden');
      } else if (code === 20902 || writeOutcomeUnknown(cause)) {
        const message = code === 20902 ? t.errors.conflict : t.errors.unknown;
        setNotice({ type: code === 20902 ? 'error' : 'warning', text: message });
        const ok = await reread(key);
        if (!ok)
          setNotice({ type: 'error', text: `${message} ${t.errors.rereadFailed}`, reload: true });
      } else if (code === 20001) {
        const fields = fieldsOf(cause);
        setNotice(
          fields.length === 0
            ? { type: 'error', text: t.errors.invalidNoFields }
            : { type: 'error', text: t.errors.invalid, fields },
        );
      } else if (code === 42901) {
        setNotice({ type: 'error', text: t.errors.rateLimited });
      } else {
        setNotice({
          type: 'error',
          text: t.errors.failed(serverMessage(cause)),
        });
      }
    } finally {
      setWriting(false);
    }
  };

  const save = () => {
    if (writingRef.current) return;
    const parsed = parseSections(text);
    if (!parsed.ok) {
      setNotice({ type: 'error', text: parsed.message });
      return;
    }
    void perform({ kind: 'save', sections: parsed.sections });
  };

  const openDialog = (next: Dialog) => {
    if (writingRef.current) return;
    setNotice(undefined);
    setDialog(next);
  };

  const openHistory = () => {
    if (writingRef.current) return;
    setView('history');
    setDetail(null);
    void loadVersions(pageKey, 1);
  };

  const viewVersion = (version: number) => {
    const sequence = ++detailSequence.current;
    setDetail({ version, status: 'loading' });
    void custom()<PageVersion>({ url: versionUrl(pageKey, version), method: 'get' }).then(
      (response) => {
        if (sequence !== detailSequence.current) return;
        setDetail({ version, status: 'ready', sections: response.data.sections });
      },
      () => {
        if (sequence !== detailSequence.current) return;
        setDetail({ version, status: 'failed' });
      },
    );
  };

  const noticeNode =
    notice === undefined ? null : (
      <Alert
        type={notice.type}
        showIcon
        closable
        message={notice.text}
        description={
          notice.fields === undefined ? undefined : (
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {notice.fields.map((field) => (
                <li key={field}>
                  <Typography.Text>{field}</Typography.Text>
                </li>
              ))}
            </ul>
          )
        }
        action={
          notice.reload === true ? (
            <Button size="small" disabled={writing} onClick={reloadNow}>
              {t.actions.reload}
            </Button>
          ) : undefined
        }
        onClose={() => setNotice(undefined)}
      />
    );

  if (status === 'forbidden')
    return (
      <Flex vertical gap={16}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        {noticeNode}
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      </Flex>
    );
  if (status === 'loading')
    return (
      <Flex vertical gap={16} aria-busy>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Card aria-busy>
          <Typography.Text type="secondary" role="status">
            {t.loading}
          </Typography.Text>
        </Card>
      </Flex>
    );
  if (status === 'failed')
    return (
      <Flex vertical gap={16}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Card>
          <Result
            status="error"
            title={t.loadFailedTitle}
            subTitle={t.loadFailedDescription}
            extra={<Button onClick={retry}>{t.actions.retry}</Button>}
          />
        </Card>
      </Flex>
    );

  const gray = page?.gray_version ?? null;
  let modal: ReactElement | null = null;
  if (dialog?.kind === 'publish')
    modal = (
      <PublishModal
        version={dialog.version}
        hasCurrent={page !== null && page.current_version !== null}
        writing={writing}
        onCancel={() => setDialog(undefined)}
        onSubmit={(percent) => void perform({ kind: 'publish', version: dialog.version, percent })}
      />
    );
  else if (dialog?.kind === 'adjust' && gray !== null && page !== null)
    modal = (
      <GrayModal
        version={gray}
        current={page.gray_percent}
        writing={writing}
        onCancel={() => setDialog(undefined)}
        onSubmit={(percent) => void perform({ kind: 'adjust', version: gray, percent })}
      />
    );
  else if (dialog?.kind === 'full' && gray !== null)
    modal = (
      <ConfirmActionModal
        title={t.confirm.fullTitle(gray)}
        body={t.confirm.fullBody(gray)}
        submit={t.confirm.fullSubmit}
        danger={false}
        writing={writing}
        onCancel={() => setDialog(undefined)}
        onSubmit={() => void perform({ kind: 'adjust', version: gray, percent: 100 })}
      />
    );
  else if (dialog?.kind === 'stop' && gray !== null)
    modal = (
      <ConfirmActionModal
        title={t.confirm.stopTitle(gray)}
        body={t.confirm.stopBody(gray)}
        submit={t.confirm.stopSubmit}
        danger
        writing={writing}
        onCancel={() => setDialog(undefined)}
        onSubmit={() => void perform({ kind: 'rollback', version: gray, stop: true })}
      />
    );
  else if (dialog?.kind === 'rollback') {
    const target = dialog.version;
    modal = (
      <ConfirmActionModal
        title={t.confirm.rollbackTitle(target)}
        body={target === gray ? t.confirm.rollbackGrayBody(target) : t.confirm.rollbackBody(target)}
        submit={t.confirm.rollbackSubmit}
        danger
        writing={writing}
        onCancel={() => setDialog(undefined)}
        onSubmit={() => void perform({ kind: 'rollback', version: target, stop: target === gray })}
      />
    );
  }

  return (
    <>
      {view === 'editor' ? (
        <EditorView
          pageKeys={pageKeys}
          pageKey={pageKey}
          page={page}
          latest={latest}
          text={text}
          blocks={blocks}
          blocksStale={blocksStale}
          basedOn={basedOn}
          preview={preview}
          busy={writing}
          switching={switching}
          notice={noticeNode}
          onSelectPage={selectPage}
          onText={applyText}
          onSave={save}
          onPublish={() => {
            if (page?.latest_version != null)
              openDialog({ kind: 'publish', version: page.latest_version });
          }}
          onPreview={() => {
            if (page?.latest_version != null)
              void perform({ kind: 'preview', version: page.latest_version });
          }}
          onHistory={openHistory}
        />
      ) : (
        <HistoryView
          pageKey={pageKey}
          page={page}
          versions={versions}
          detail={detail}
          busy={writing}
          notice={noticeNode}
          onBack={() => {
            setView('editor');
            setDetail(null);
          }}
          onPage={(number) => void loadVersions(pageKey, number)}
          onRetry={() => void loadVersions(pageKey, versionsPage.current)}
          onView={viewVersion}
          onCloseDetail={() => {
            detailSequence.current += 1;
            setDetail(null);
          }}
          onPublish={(version) => openDialog({ kind: 'publish', version })}
          onRollback={(version) => openDialog({ kind: 'rollback', version })}
          onAdjust={() => openDialog({ kind: 'adjust' })}
          onFull={() => openDialog({ kind: 'full' })}
          onStop={() => openDialog({ kind: 'stop' })}
        />
      )}
      {modal}
    </>
  );
}
