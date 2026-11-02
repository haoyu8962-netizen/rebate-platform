// B1-10n: without a configured private import store the import fails closed (contract 5XX, never
// `queued`). The store here is platform's real implementation for an environment without its OSS
// adapter (createImportStore as staging / prod build it, B1-30): the entry itself stays in the test
// environment so that nothing else of it changes. Top-level it() only (规划/11 §4.3).
import { expect, it, vi } from 'vitest';
import type { ImportStoreOptions } from '../../../../apps/api/src/modules/platform/import-store/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { ANSWER, GRANTS, IMPORTS, accepted, allowed, arrange, refused, setup } from './kit.ts';

vi.mock(
  '../../../../apps/api/src/modules/platform/import-store/index.ts',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../apps/api/src/modules/platform/import-store/index.ts')
      >();
    return {
      ...actual,
      createImportStore: (options: ImportStoreOptions) =>
        actual.createImportStore({ ...options, appEnv: 'staging' }),
    };
  },
);

const h = useHarness();

it.each(['rights', 'channel'] as const)(
  '[AC-B1-10n#25] 导入存储未配置：%s → 50001，不返回 queued，不留任务、审计与作业',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    const before = await s.state();
    await refused(await act(await allowed(s, action)), 50001);
    expect(await s.state()).toEqual(before);
    expect(s.f.lines.join('\n')).toContain('import_store_unavailable');
    const page = await accepted(await s.get(`${IMPORTS}?page=1&page_size=20`), ANSWER.list);
    expect(page).toMatchObject({ items: [], total: 0 });
  },
  120_000,
);
