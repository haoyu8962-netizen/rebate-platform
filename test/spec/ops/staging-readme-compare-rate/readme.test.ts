import { expect, it } from 'vitest';
import { asset } from '../../infra/staging/kit.ts';

const COMPARE_KEY = 'rebate.taobao.compare_rate_ratio_bp';
const QUOTE_FAILURE = /缺(?:少)?(?:任何一项|任一项|一项|项)[^。；]*报价失败/;
const LIVE_CUTOVER = /先.*(?:再|才能)切\s*live|切\s*live\s*(?:前|之前)/;
const SETUP_STEP = /配(?:置|好|齐)/;
const UPDATE_STEP = /修改|改(?:好|取值|值)/;
const COMPARE_KEY_REFERENCE =
  /(?:它|[该此本](?:配置)?键|淘宝比价(?:比例)?键|`?rebate\.taobao\.compare_rate_ratio_bp`?)/;
const EXEMPTS_COMPARE_KEY = new RegExp(
  `对\\s*${COMPARE_KEY_REFERENCE.source}\\s*(?:均|都|也)?不(?:再)?适用|不(?:再)?适用于?\\s*${COMPARE_KEY_REFERENCE.source}`,
);
const ONLY_TECH_FEE = /(?:只|仅)(?:对|适用于?)\s*`?tech_fee_bp\b/;
const TECH_FEE_STILL_REQUIRED =
  /`?tech_fee_bp`?[^。；]*(?:(?:仍|继续)(?:需|须|按|要|适用)|要求照旧|要求不变)/;

function sectionLines(): string[] {
  const lines = asset('infra/staging/README.md').split(/\r?\n/);
  const start = lines.findIndex((line) => /^### 1\.10(?:\s|$)/.test(line));
  expect(start, 'README 应保留 1.10 节').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end).filter((line) => line.trim() !== '');
}

function exemptionClauses(correction: string): string[] {
  return correction
    .split(/[。；]/)
    .filter((clause) => EXEMPTS_COMPARE_KEY.test(clause) || ONLY_TECH_FEE.test(clause));
}

// AC-B2-03z 编号对应本轮任务书的追加说明验收点。
it('[AC-B2-03z#1] 1.10 末尾仅一行说明淘宝比价比例键已登记、报价不读（D10-641）、切 live 前不用配', () => {
  const lines = sectionLines();
  const corrections = lines.filter(
    (line) => line.includes(COMPARE_KEY) && line.includes('D10-641'),
  );
  expect(corrections, '1.10 应有且只有一行引用 D10-641 纠正该键的说明').toHaveLength(1);
  const [correction = ''] = corrections;
  expect(correction, '纠正说明应放在 1.10 末尾').toBe(lines.at(-1));
  expect(correction).toContain('config.business');
  expect(correction).toMatch(/已登记|仍(?:然)?登记|保留登记/);
  expect(correction).toMatch(/报价(?:器)?\s*不(?:会|再)?读(?:取)?/);
  expect(correction).toMatch(/(?:不(?:用|必|需(?:要)?)|无需)\s*(?:另行|另|再)?\s*配/);
});

it('[AC-B2-03z#2] 追加说明明确上文缺项时报价失败的要求对淘宝比价比例键不适用', () => {
  const correction = sectionLines().at(-1) ?? '';
  expect(
    exemptionClauses(correction).some((clause) => QUOTE_FAILURE.test(clause)),
    '应说明上文的缺项时报价失败对淘宝比价比例键不适用',
  ).toBe(true);
});

it('[AC-B2-03z#3] 追加说明解除淘宝比价比例键的两项 live 前配置要求，保留技术服务费的要求', () => {
  const lines = sectionLines();
  const correction = lines.at(-1) ?? '';
  expect(
    exemptionClauses(correction).some(
      (clause) => LIVE_CUTOVER.test(clause) && SETUP_STEP.test(clause) && UPDATE_STEP.test(clause),
    ),
    '应说明上文的先配好和改好再切 live 对淘宝比价比例键不适用',
  ).toBe(true);
  expect(
    ONLY_TECH_FEE.test(correction) || TECH_FEE_STILL_REQUIRED.test(correction),
    '应说明技术服务费仍须按原要求配置',
  ).toBe(true);

  const previous = lines.slice(0, -1).join('\n');
  expect(previous).toContain('缺任何一项时报价失败');
  expect(previous).toMatch(/^- `tech_fee_bp` .*先在 staging 配好.*再切 live。$/m);
  expect(previous).toMatch(/^- `tech_fee_bp` .*在后台改好取值后再切 live。$/m);
});
