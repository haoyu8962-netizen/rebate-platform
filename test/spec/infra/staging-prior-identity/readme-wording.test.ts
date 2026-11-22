import { expect, it } from 'vitest';
import { asset, ENTRIES } from '../staging/kit.ts';

const FIELD_MASTER = /\bFIELD_MASTER_KEY_FILE\b/;
const MAIN_MASTER_FILE = /(?<![\w.-])master\.key(?![\w.-])/;
const PRIOR_MASTER_FILE = /(?<![\w.-])prior-identity-master\.key(?![\w.-])/;
const STAGING = /(?<![\w.-])staging(?![\w.-])/i;
const SHARING = /共用|共享|复用|同一(?:个|份)?(?:主密钥|文件|路径)/;
const ALLOWS_SHARING = /允许|可以|可(?=\s*(?:与|和|跟|共用|共享|复用|使用|用|指向|为))/;
const FORBIDS_SHARING = /不\s*(?:可|允许|能|得|应|共用|共享|复用|使用|用)|禁止|严禁|勿/;

function statements(): string[] {
  const readme = asset('infra/staging/README.md');
  const afterFieldKeyring =
    /^### 1\.3[ \t][^\n]*\n([\s\S]*?)(?=^### 1\.4[ \t])/m.exec(readme)?.[1] ?? '';
  const section = /^#{3,4}[ \t]+[^\n]*旧身份[^\n]*\n([\s\S]*)/m.exec(afterFieldKeyring)?.[1] ?? '';
  return section
    .replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*/gm, '')
    .replace(/[`*]/g, '')
    .split(/[。；！？;!?]|\n\s*\n/);
}

// D10-2524 ① and ledger ③: a denial contains the same permission words as an allowance.
it('[AC-B1-01zzx#6] 契约允许旧身份和主密钥环共用主密钥文件', () => {
  const masterSharing = statements()
    .flatMap((sentence) => sentence.split(/[，,]/))
    .filter((clause) => FIELD_MASTER.test(clause) && SHARING.test(clause) && !STAGING.test(clause));

  expect(masterSharing.filter((clause) => FORBIDS_SHARING.test(clause))).toEqual([]);
  expect(masterSharing.some((clause) => ALLOWS_SHARING.test(clause))).toBe(true);
});

// D10-2524 ② and ledger ③: the staging procedure uses a separate master key.
it('[AC-B1-01zzx#7] staging 明确使用独立主密钥，步骤不允许沿用主密钥环的主密钥文件', () => {
  const staging = statements().filter((sentence) => STAGING.test(sentence));
  const independent =
    /(?:独立|单独|另一把|另(?:行)?生成)(?:的)?\s*(?:旧身份(?:的)?\s*)?主密钥|主密钥\s*(?:须|必须|应|需(?:要)?)?\s*(?:独立|单独生成)/;
  const skipsIndependent =
    /(?:不(?:必|用|需(?:要)?|应|允许)|无需|禁止)\s*(?:再|使用|采用|生成|准备)?\s*(?:独立|单独|另一把|另行生成)(?:的)?\s*(?:旧身份(?:的)?\s*)?主密钥/;
  expect(
    staging.some(
      (sentence) =>
        independent.test(sentence) &&
        (/\bD10-336\b/.test(sentence) || PRIOR_MASTER_FILE.test(sentence)),
    ),
    '说明 staging 的独立主密钥，并写明先例或该文件名',
  ).toBe(true);
  expect(staging.filter((sentence) => skipsIndependent.test(sentence))).toEqual([]);

  const stagingClauses = staging
    .flatMap((sentence) => sentence.split(/[，,]/))
    .filter((clause) => STAGING.test(clause));
  const usesMainMaster =
    /(?:用|指向)\s*(?:现有的?\s*)?(?:(?:\/(?:etc|run)\/couli-keys\/)?master\.key(?![\w.-])|FIELD_MASTER_KEY_FILE\b)/;
  expect(
    stagingClauses.filter(
      (clause) =>
        (MAIN_MASTER_FILE.test(clause) || FIELD_MASTER.test(clause)) &&
        (SHARING.test(clause) || usesMainMaster.test(clause)) &&
        !FORBIDS_SHARING.test(clause),
    ),
    'staging 的说明不可允许使用主密钥环的主密钥文件',
  ).toEqual([]);
});

it('[AC-B1-01zzx#8] 两把主密钥都要离线备份', () => {
  const backup = statements().filter((sentence) => sentence.includes('离线备份'));
  const optionalBackup =
    /(?:不必|不用|不需(?:要)?|无需|不要|不应|禁止|可以选择)\s*(?:(?:再|另行|同时|都|分别|做|进行)\s*)*离线备份|离线备份\s*(?:可省略|可选|不是必需)/;
  expect(backup.filter((sentence) => optionalBackup.test(sentence))).toEqual([]);
  expect(
    backup.some(
      (sentence) =>
        /(?:两|2)\s*把\s*主密钥/.test(sentence) ||
        (MAIN_MASTER_FILE.test(sentence) && PRIOR_MASTER_FILE.test(sentence)),
    ),
    '重复写旧身份主密钥文件名不算列出两把主密钥',
  ).toBe(true);
});

it('[AC-B1-01zzx#9] 缺少这组配置时五个入口均拒绝启动', () => {
  const startup = statements().filter(
    (sentence) =>
      /缺|漏|未配|未设|没配|没设/.test(sentence) &&
      (/(?:五|5)\s*个\s*(?:入口|进程|服务)/.test(sentence) ||
        ENTRIES.every((entry) => sentence.includes(entry))),
  );
  const failure = /启动(?:即|就)?失败|拒绝启动|无法启动/;
  const deniesFailure =
    /(?:不(?:会|一定|再)?|未)\s*(?:启动(?:即|就)?失败|拒绝启动|无法启动)|照常启动|可以正常启动/;
  expect(startup.some((sentence) => failure.test(sentence))).toBe(true);
  expect(startup.filter((sentence) => deniesFailure.test(sentence))).toEqual([]);
});

it('[AC-B1-01zzx#10] 生产环境使用 KMS', () => {
  const production = statements().filter((sentence) => /\bprod\b|生产环境/i.test(sentence));
  const usesKms = /(?:走|用|采用|通过|由|(?:只|仅)允许|=)\s*KMS\b/i;
  const deniesKms =
    /(?:不(?:需(?:要)?|必|会|能|得|允许|支持)?|无需|禁止)\s*(?:走|使?用|采用|通过)?\s*KMS\b/i;
  expect(production.some((sentence) => usesKms.test(sentence))).toBe(true);
  expect(production.filter((sentence) => deniesKms.test(sentence))).toEqual([]);
});
