// B1-10n: an accepted upload through the real admin entry leaves one audit record for the whole
// file (08 BR-ATTR-26 细则「渠道单导入」, BR-FUND-06; 任务书第 10 节第 1 条). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { ANSWER, GRANTS, IP, accepted, allowed, arrange, setup } from './kit.ts';

const h = useHarness();

it.each(['rights', 'channel'] as const)(
  '[AC-B1-10n#26] %s 受理成功的上传：audit_logs 正好一行，action rights_import_create、target rights_imports:<import_id>、admin_id 是操作者',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const act = await arrange(s, action);
    const created = await accepted<{ import_id: string }>(
      await act(await allowed(s, action)),
      ANSWER[action],
    );
    expect((await s.state()).audits).toEqual([
      expect.objectContaining({
        action: 'rights_import_create',
        target: `rights_imports:${created.import_id}`,
        admin_id: s.admin.id,
        ip: IP,
      }),
    ]);
  },
  120_000,
);
