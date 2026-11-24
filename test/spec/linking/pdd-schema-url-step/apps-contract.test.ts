import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { apps } from '../../../../packages/contracts-ts/src/bridge.gen.ts';

it('[AC-B1-06zp#4] 生成的 bridge 反映拼多多的登记状态与两端 scheme 配置', () => {
  expect(apps.pdd).toMatchObject({
    status: 'verified',
    ios_query_schemes: ['pinduoduo'],
    harmony_query_schemes: [],
  });
});

it('[AC-B1-06zp#5] apps.json 注释记录 iOS 与鸿蒙仍待真机验证', () => {
  const url = new URL('../../../../contracts/apps.json', import.meta.url);
  const doc = JSON.parse(readFileSync(url, 'utf8')) as { $comment: string };
  expect(doc.$comment).not.toContain('Nothing here is verified yet');
  const pending = '(?:未|待|pending|untested|not (?:yet )?(?:tested|verified))';
  expect(doc.$comment).toMatch(new RegExp(`iOS[^.;。；]{0,60}${pending}`, 'iu'));
  expect(doc.$comment).toMatch(new RegExp(`(?:鸿蒙|Harmony)[^.;。；]{0,60}${pending}`, 'iu'));
});
