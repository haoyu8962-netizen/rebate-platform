// The synthetic column templates of the import rule tests (K-3: no real template exists yet;
// ../rights-import-task precedent). A test file injects them over the real rights_import job with
//   vi.mock(<jobs/rights-import.ts>, async (importOriginal) =>
//     (await import('./templates.ts')).withTemplates(await importOriginal<RightsImportJob>()));
// the job's store, processors and everything else stay the worker assembly's.
export type RightsImportJob =
  typeof import('../../../../apps/api/src/modules/orders/jobs/rights-import.ts');

export const TEMPLATES = {
  rights: {
    columns: {
      sub_order_id: '子订单号（合成）',
      rights_no: '维权单号（合成）',
      status: '维权状态（合成）',
      amount: '维权金额（合成）',
      deduction_commission: '扣回佣金（合成）',
      occurred_at: '发生时间（合成）',
    },
  },
  punish: {
    columns: {
      sub_order_id: '子订单号（合成）',
      rights_no: '违规单号（合成）',
      amount: '违规金额（合成）',
      deduction_commission: '扣回佣金（合成）',
      occurred_at: '发生时间（合成）',
    },
  },
  channel: { columns: { relation_id: '渠道关系（合成）', end_at: '截止时间（合成）' } },
} as const;

export function withTemplates(actual: RightsImportJob): RightsImportJob {
  return {
    ...actual,
    handleRightsImport: (job, deps) =>
      actual.handleRightsImport(job, {
        ...deps,
        templates: { find: (kind) => TEMPLATES[kind] },
      }),
  };
}
