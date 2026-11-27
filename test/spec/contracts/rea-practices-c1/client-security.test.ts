import { expect, it } from 'vitest';
import { list, mapping, readMapping } from './kit.ts';

// 规划/03 §4.8 CSB-12（RA-07）。台账只登记发布要求和验收规则。
const legacyIds = Array.from(
  { length: 11 },
  (_, index) => `CSB-${String(index + 1).padStart(2, '0')}`,
);

it('[AC-CT-26zs#14] CSB-12 登记三端发布包保护及验收', async () => {
  // 漏条目、换序、漏端、只要求代码压缩或允许安装包带映射表，都会失败。
  const spec = await readMapping('specs/client-security-baseline.yaml');
  const rules = list(spec['rules'], 'CSB rules').map((rule) => mapping(rule, 'CSB rule'));
  expect(rules.map((rule) => rule['id']).slice(0, 12)).toEqual([...legacyIds, 'CSB-12']);
  expect(Number(spec['version'])).toBeGreaterThan(1);
  const releaseRules = rules.filter((rule) => rule['id'] === 'CSB-12');
  expect(releaseRules).toHaveLength(1);
  for (const rule of releaseRules) {
    expect(rule['title']).toContain('发布包代码压缩与混淆');
    expect(list(rule['platforms'], 'CSB-12 platforms').sort()).toEqual([
      'android',
      'harmony',
      'ios',
    ]);
    const targets = list(rule['targets'], 'CSB-12 targets');
    expect(targets.length).toBeGreaterThan(0);
    const check = String(rule['check']);
    const requirement = [rule['title'], check, ...targets].map(String).join(' ');
    for (const clause of [
      /Android/iu,
      /Release/iu,
      /R8/u,
      /代码压缩|minifyEnabled/u,
      /资源压缩|shrinkResources/u,
      /预发|staging/iu,
      /回归|regression/iu,
      /混淆.{0,5}构建|obfuscat.{0,20}build/iu,
      /崩溃.{0,12}(?:映射|还原|验证)|crash.{0,20}(?:mapping|symbolication)/iu,
      /(?:不采纳|不使用).{0,8}商用.{0,8}(?:加壳|加固)|no commercial.{0,15}(?:pack|harden)/iu,
      /(?:不放|不得放|不内置|禁止内置).{0,8}(?:秘密|密钥)|(?:no|never embed).{0,12}secret/iu,
    ]) {
      expect(requirement).toMatch(clause);
    }
    for (const clause of [
      /Android/iu,
      /代码.{0,12}资源.{0,8}压缩|minifyEnabled.{0,60}shrinkResources/isu,
      /iOS/iu,
      /鸿蒙|Harmony/iu,
      /剥离|strip/iu,
      /符号.{0,12}(?:仅上传|只上传)|(?:only|solely).{0,30}(?:mapping|symbol)/iu,
      /崩溃平台|crash platform/iu,
      /(?:不打进|不打入|不得打进|不打包进|不进入|不得进入).{0,8}安装包|(?:not|never).{0,20}(?:package|bundle)/iu,
    ]) {
      expect(check).toMatch(clause);
    }
  }
});
