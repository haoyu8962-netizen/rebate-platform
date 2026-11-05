import { expect, it } from 'vitest';
import { pddAuthorityLink } from '../../../../apps/api/src/modules/linking/application/pdd-authority.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-662, superseding D10-647 ②'s single pick): of a pddAuthorityUrl
// answer the jump is built over two things — the web address (mobile_short_url, else url; never
// short_url, browser_url or schema_url) and the upstream App scheme (schema_url as is, else null).
const SCHEMA = 'synthetic-schema://authority/b1-06zf';
const MOBILE_SHORT = 'https://short.example.invalid/m/b1-06zf';
const URL_FIELD = 'https://landing.example.invalid/authority/b1-06zf';
const SHORT = 'https://short.example.invalid/s/b1-06zf';
const BROWSER = 'https://browser.example.invalid/authority/b1-06zf';

it('[AC-B1-06zf#18] 字段都在时：网页地址取 mobile_short_url，上游 scheme 取 schema_url 原样（不取 short_url / browser_url / url）', () => {
  expect(
    pddAuthorityLink({
      url: URL_FIELD,
      schema_url: SCHEMA,
      mobile_short_url: MOBILE_SHORT,
      short_url: SHORT,
      browser_url: BROWSER,
    }),
  ).toEqual({ webUrl: MOBILE_SHORT, scheme: SCHEMA });
});

it('[AC-B1-06zf#19] 没有 schema_url 时：网页地址仍取 mobile_short_url，上游 scheme 为 null（不拿任何 https 字段充当 scheme）', () => {
  expect(
    pddAuthorityLink({
      url: URL_FIELD,
      mobile_short_url: MOBILE_SHORT,
      short_url: SHORT,
      browser_url: BROWSER,
    }),
  ).toEqual({ webUrl: MOBILE_SHORT, scheme: null });
});

it('[AC-B1-06zf#20] 没有 mobile_short_url 时网页地址取 url（不取 short_url / browser_url / schema_url）；scheme 有则原样、无则 null', () => {
  expect(
    pddAuthorityLink({
      url: URL_FIELD,
      schema_url: SCHEMA,
      short_url: SHORT,
      browser_url: BROWSER,
    }),
  ).toEqual({ webUrl: URL_FIELD, scheme: SCHEMA });
  expect(pddAuthorityLink({ url: URL_FIELD, short_url: SHORT, browser_url: BROWSER })).toEqual({
    webUrl: URL_FIELD,
    scheme: null,
  });
  expect(pddAuthorityLink({ url: URL_FIELD })).toEqual({ webUrl: URL_FIELD, scheme: null });
});
