// B1-10n: the real worker entry has rightsImports configured. No template is injected here: whatever
// the registry holds (K-3: no real template yet), a sheet under a header no template names is the
// row failure invalid_row on every row, and the task ends done, never failed: the job found its
// store, its registry and a processor of the kind (rights-import-ports.ts). Without rightsImports
// the job throws, without a processor the task ends failed. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ANSWER,
  GRANTS,
  accepted,
  allowed,
  arrange,
  detailOf,
  setup,
  shareImportStore,
  worker,
} from './kit.ts';

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(['rights', 'punish', 'channel'] as const)(
  '[AC-B1-10n#15] 真实 worker 入口配好了 rightsImports：%s 任务跑完是 done，不是 failed；表头对不上任何模板时每行记 invalid_row',
  async (action) => {
    shareImportStore();
    const s = await setup(h, { grants: GRANTS[action] });
    const w = await worker(h);
    const act = await arrange(s, action);
    const created = await accepted<{ import_id: string }>(
      await act(await allowed(s, action)),
      ANSWER[action],
    );
    await w.run(s.importJob(created.import_id));
    expect(await detailOf(s, created.import_id)).toMatchObject({
      status: 'done',
      total_rows: 1,
      succeeded_rows: 0,
      failed_rows: 1,
      failures: [{ row_no: 2, reason: 'invalid_row' }],
    });
  },
  120_000,
);
