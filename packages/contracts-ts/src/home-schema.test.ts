// CT-07a: contracts/home-schema.json (03 §6.1–§6.3, 04 §6.2 NoticeItem, 04 §10.1 jump targets)
// and its golden fixtures (operation-slot fixtures CT-27: operation-slots.test.ts). The schema compiles under the API workspace's strict Ajv2020 (same
// loader as admin-auth.test.ts); every golden page passes, every invalid/ page is rejected; the
// golden jump targets name routes of routes.json and pass that route's params schema; shared
// shapes match openapi.yaml and enums/.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { enums } from './index.ts';

const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
interface ValidateFn {
  (data: unknown): boolean;
  errors?: unknown;
}
interface Validator {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): ValidateFn;
}
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => Validator;
};
const addFormats = apiRequire('ajv-formats') as (ajv: Validator) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};

type Json = Record<string, unknown>;
type Section = Json & { id: string; type: string };
type Page = Json & { sections: Section[] };

const contractsDir = new URL('../../../contracts/', import.meta.url);
const goldenDir = new URL('fixtures/home-golden/', contractsDir);
const invalidDir = new URL('invalid/', goldenDir);

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

function jsonFiles(dir: URL): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

const schema = readJson<Json & { $defs: Record<string, Json> }>(
  new URL('home-schema.json', contractsDir),
);
const routes = readJson<{ routes: Record<string, { params: object; debug_only?: boolean }> }>(
  new URL('routes.json', contractsDir),
).routes;

const GOLDEN = [
  'conditions.json',
  'external-page.json',
  'home-full.json',
  'me-more-services.json',
  'min-app-version.json',
  'notice-bar-api.json',
  'notice-bar-static.json',
  'popup-lottie.json',
  'popup-scheduled.json',
  'popup-static.json',
  'search-top-banner.json',
  'search-top-products.json',
  'union-material.json',
  'unknown-type.json',
];
const INVALID = [
  'ad-label-not-banner.json',
  'api-with-path.json',
  'banner-item-badge.json',
  'condition-null.json',
  'condition-true.json',
  'condition-unknown-key.json',
  'me-badge-overlong.json',
  'me-external-page.json',
  'me-icon-and-image.json',
  'me-icon-digest-unbound.json',
  'me-invite-share.json',
  'me-item-end-at-utc.json',
  'me-items-over-limit.json',
  'me-labor-agreement.json',
  'me-unlisted-type.json',
  'min-app-version-bad.json',
  'notice-bar-api-with-items.json',
  'notice-bar-api-wrong-type.json',
  'notice-bar-static-items-in-source.json',
  'popup-alt-41.json',
  'popup-alt-empty.json',
  'popup-lottie-extra-key.json',
  'popup-lottie-http.json',
  'popup-lottie-no-image.json',
  'popup-lottie-no-sha256.json',
  'popup-lottie-sha256-63.json',
  'popup-lottie-sha256-uppercase.json',
  'product-grid-columns-3.json',
  'search-more-external.json',
  'search-two-top-slots.json',
  'search-unlisted-type.json',
  'two-popups.json',
  'union-material-empty-channels.json',
  'union-material-platforms.json',
];
const REGISTERED = [
  'banner',
  'icon_grid',
  'product_scroll',
  'product_grid',
  'activity_entry',
  'notice_bar',
  'feed_infinite',
  'popup',
];

let validate: ValidateFn;
let ajv: Validator;
let openapi: {
  components: { schemas: Record<string, Json>; parameters: Record<string, { schema: Json }> };
};

beforeAll(async () => {
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  validate = ajv.compile(schema);
  openapi = (await dereference(
    fileURLToPath(new URL('openapi.yaml', contractsDir)),
  )) as typeof openapi;
});

/** Drops description / $comment recursively and inlines the local $defs references. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value !== 'object' || value === null) return value;
  const object = value as Json;
  const ref = object['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    return normalise(schema.$defs[ref.slice('#/$defs/'.length)]);
  }
  const out: Json = {};
  for (const [key, child] of Object.entries(object)) {
    if (key === 'description' || key === '$comment') continue;
    out[key] = normalise(child);
  }
  return out;
}

/** Every object with a route key below value, with its JSON path. */
function targets(value: unknown, path: string, out: [string, Json][] = []): [string, Json][] {
  if (Array.isArray(value)) value.forEach((item, i) => targets(item, `${path}.${i}`, out));
  else if (typeof value === 'object' && value !== null) {
    const object = value as Json;
    if (Object.hasOwn(object, 'route')) out.push([path, object]);
    for (const [key, child] of Object.entries(object)) targets(child, `${path}.${key}`, out);
  }
  return out;
}

describe('home-schema.json (CT-07a)', () => {
  it('compiles under strict Ajv2020 and registers the 8 card types of 03 §6.3', () => {
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(typeof validate).toBe('function');
    for (const type of REGISTERED) expect(schema.$defs).toHaveProperty(`section_${type}`);
    for (const def of ['section', 'route_target', 'notice_item', 'condition', 'min_app_version']) {
      expect(schema.$defs).toHaveProperty(def);
    }
  });

  it('the fixture directories hold exactly the listed files', () => {
    expect(jsonFiles(goldenDir)).toEqual(GOLDEN);
    expect(jsonFiles(invalidDir)).toEqual(INVALID);
  });

  it.each(GOLDEN)('golden %s passes', (name) => {
    const page = readJson<Page>(new URL(name, goldenDir));
    const ok = validate(page);
    expect(validate.errors ?? null, name).toBeNull();
    expect(ok).toBe(true);
  });

  it.each(INVALID)('invalid/%s is rejected', (name) => {
    expect(validate(readJson(new URL(name, invalidDir)))).toBe(false);
  });

  it('home-full has every registered type once; unknown-type has one unregistered type', () => {
    const full = readJson<Page>(new URL('home-full.json', goldenDir));
    expect(full.sections.map((s) => s.type).sort()).toEqual([...REGISTERED].sort());
    const unknown = readJson<Page>(new URL('unknown-type.json', goldenDir));
    expect(unknown.sections.filter((s) => !REGISTERED.includes(s.type))).toHaveLength(1);
  });

  it.each(GOLDEN)('golden %s: section ids are unique and at most one popup', (name) => {
    const { sections } = readJson<Page>(new URL(name, goldenDir));
    const ids = sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sections.filter((s) => s.type === 'popup').length).toBeLessThanOrEqual(1);
  });

  it('golden jump targets are routes.json routes (not debug_only) with valid params', () => {
    let count = 0;
    for (const name of GOLDEN) {
      const page = readJson<Page>(new URL(name, goldenDir));
      for (const [path, target] of targets(page.sections, 'sections')) {
        count += 1;
        const route = routes[target['route'] as string];
        expect(route, `${name} ${path}.route`).toBeDefined();
        expect(route!.debug_only ?? false, `${name} ${path}.route`).toBe(false);
        const check = ajv.compile(route!.params);
        expect(check(target['params'] ?? {}), `${name} ${path}.params`).toBe(true);
        if (target['route'] === 'ExternalPage') {
          const url = new URL((target['params'] as { url: string }).url);
          expect(url.hostname, `${name} ${path}.params.url`).toBe('example.com');
        }
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('$defs/notice_item and $defs/route_target equal openapi NoticeItem and RouteTarget', () => {
    const { schemas } = openapi.components;
    expect(normalise(schema.$defs['notice_item'])).toEqual(normalise(schemas['NoticeItem']));
    expect(normalise(schema.$defs['route_target'])).toEqual(normalise(schemas['RouteTarget']));
  });

  it('page fields and app versions match openapi Page, PageKeyPath and X-App-Version', () => {
    const { schemas, parameters } = openapi.components;
    const page = schemas['Page'] as { properties: Record<string, unknown> };
    const props = schema['properties'] as Record<string, Json>;
    expect(normalise(props['version'])).toEqual(normalise(page.properties['version']));
    expect(normalise(props['ttl_sec'])).toEqual(normalise(page.properties['ttl_sec']));
    expect(props['page_key']!['pattern']).toBe(parameters['PageKeyPath']!.schema['pattern']);
    const appVersion = parameters['AppVersion']!.schema;
    expect(schema.$defs['app_version']!['pattern']).toBe(appVersion['pattern']);
    expect(schema.$defs['app_version']!['maxLength']).toBe(appVersion['maxLength']);
  });

  it('popup lottie {url, sha256} matches the popup asset upload of openapi (CT-07b, 04 §6.2)', () => {
    const popup = schema.$defs['section_popup'] as {
      properties: { props: Json & { properties: Record<string, Json> } };
    };
    const props = popup.properties.props;
    expect(props['dependentRequired']).toEqual({ lottie: ['image'] });
    const lottie = props.properties['lottie'] as Json & { properties: Record<string, Json> };
    expect(lottie['required']).toEqual(['url', 'sha256']);
    expect(lottie['additionalProperties']).toBe(false);
    const { schemas } = openapi.components;
    expect(lottie.properties['sha256']!['pattern']).toBe(
      schemas['AdminPopupAssetSha256']!['pattern'],
    );
    expect(lottie.properties['url']!['pattern']).toBe(schemas['AdminPopupAssetUrl']!['pattern']);
    expect(props.properties['alt']).toMatchObject({ minLength: 1, maxLength: 40 });
    const golden = readJson<Page>(new URL('popup-lottie.json', goldenDir));
    const section = golden.sections.find((s) => s.type === 'popup');
    const ref = (section?.['props'] as Json)['lottie'] as { url: string; sha256: string };
    expect(new URL(ref.url).pathname).toBe(`/${ref.sha256}.json`);
  });

  it('union_material platforms are enums/ platform; condition keys and values are 03 §6.1', () => {
    const channel = schema.$defs['material_channel'] as {
      properties: { platform: { enum: string[] } };
    };
    expect(channel.properties.platform.enum).toEqual([...enums.platform]);
    const { schemas } = openapi.components;
    expect(channel.properties.platform.enum).toEqual(schemas['PlatformCode']!['enum']);
    const condition = schema.$defs['condition'] as { properties: Json };
    expect(Object.keys(condition.properties).sort()).toEqual(
      ['has_order', 'has_parent', 'login', 'union_authorized'].sort(),
    );
    expect(schema.$defs['condition_value']!['enum']).toEqual(['any', 'yes', 'no']);
  });
});
