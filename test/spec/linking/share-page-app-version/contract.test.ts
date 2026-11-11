// CT-26zj (D10-1232 / D10-1246): the contract lets getSharePage and getShareTpwd omit X-App-Version
// (X-Platform=h5 has no app version; 规划/08 BR-ID-01 「最低支持版本拦截」h5 不判版本). The shared
// AppVersion parameter stays required, so every other operation keeps a required X-App-Version,
// in contracts/openapi.yaml and in the route schemas generated from it.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

const SHARE_OPERATIONS = ['getSharePage', 'getShareTpwd'] as const;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
/** The SemVer schema of X-App-Version (contracts/openapi.yaml components.parameters.AppVersion). */
const VERSION_PATTERN = '^[0-9]+\\.[0-9]+\\.[0-9]+$';

interface Parameter {
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: { readonly pattern?: string; readonly maxLength?: number };
}
interface Operation {
  readonly operationId?: string;
  readonly parameters?: readonly Parameter[];
}
type PathItem = Readonly<Record<string, unknown>> & { readonly parameters?: readonly Parameter[] };
interface Contract {
  readonly paths: Readonly<Record<string, PathItem>>;
  readonly components: { readonly parameters: Readonly<Record<string, Parameter>> };
}
interface RouteSchema {
  readonly headers?: {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

async function contract(): Promise<Contract> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<Contract>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
}

/** The X-App-Version header parameter of every operation that declares one, by operationId. */
function versionParameters(doc: Contract): Map<string, Parameter> {
  const found = new Map<string, Parameter>();
  for (const item of Object.values(doc.paths)) {
    for (const method of METHODS) {
      const operation = item[method] as Operation | undefined;
      if (operation === undefined) continue;
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
      const version = parameters.find(
        (parameter) =>
          parameter.in === 'header' && parameter.name?.toLowerCase() === 'x-app-version',
      );
      if (version !== undefined) found.set(String(operation.operationId), version);
    }
  }
  return found;
}

it('[AC-CT-26zj#3] 契约：getSharePage、getShareTpwd 仍声明 X-App-Version（同一 SemVer 格式）但不再 required；共用的 AppVersion 参数与其他接口的 X-App-Version 仍 required（openapi 与生成的路由校验一致）', async () => {
  const doc = await contract();
  const versions = versionParameters(doc);

  for (const operationId of SHARE_OPERATIONS) {
    const version = versions.get(operationId);
    expect(version, `${operationId} 声明 X-App-Version`).toBeDefined();
    expect(version?.required ?? false, `${operationId} 的 X-App-Version 可省`).toBe(false);
    expect(version?.schema?.pattern, `${operationId} 的 X-App-Version 格式`).toBe(VERSION_PATTERN);
    expect(version?.schema?.maxLength, `${operationId} 的 X-App-Version 长度`).toBe(32);
  }

  // The shared parameter is not loosened: no other operation may omit the version.
  expect(doc.components.parameters['AppVersion']?.required).toBe(true);
  const others = [...versions].filter(
    ([operationId]) => !(SHARE_OPERATIONS as readonly string[]).includes(operationId),
  );
  expect(others.length).toBeGreaterThan(50);
  const loosened = others
    .filter(([, parameter]) => parameter.required !== true)
    .map(([operationId]) => operationId);
  expect(loosened, 'openapi 中 X-App-Version 非 required 的其他接口').toEqual([]);

  const routes = CONTRACT_ROUTE_SCHEMAS as unknown as Readonly<Record<string, RouteSchema>>;
  const routeLoosened = Object.entries(routes)
    .filter(([operationId]) => !(SHARE_OPERATIONS as readonly string[]).includes(operationId))
    .filter(([, schema]) => schema.headers?.properties?.['x-app-version'] !== undefined)
    .filter(([, schema]) => !(schema.headers?.required ?? []).includes('x-app-version'))
    .map(([operationId]) => operationId);
  expect(routeLoosened, '路由校验中 x-app-version 非 required 的其他接口').toEqual([]);
}, 60_000);
