// Request validation from the contract (ADR-0001 §2 契约行, §4.2 第 15 项; 规划/04 §5 请求头,
// §7 错误码 20001).
// The rule tests in test/spec/platform/validation/** import this file by path; names, signatures
// and the semantics written here are the contract.
//
// routeSchemaOf(operation, pathItemParameters?) → RouteSchema
//   `operation` is one operation of the dereferenced contracts/openapi.yaml (OAS 3.1, no `$ref`
//   left); `pathItemParameters` are the parameters declared on its path item. An operation
//   parameter replaces a path-item parameter with the same `in` and name (header names compared
//   without regard to case). Parts, each present only when it has something to validate:
//   - params       every `in: path` parameter: { type: 'object', properties, required: [every
//                  path parameter], additionalProperties: false }
//   - querystring  every `in: query` parameter: { type: 'object', properties, required: [the
//                  required ones], additionalProperties: false } (unknown query keys are refused)
//   - headers      every `in: header` parameter, its name lower-cased: { type: 'object',
//                  properties, required: [the required ones] } (other headers stay allowed:
//                  no additionalProperties keyword)
//   - body         `requestBody.content['application/json'].schema`, unchanged
//   - multipart    `true` when the request body is `required: true` and its content is exactly
//                  `multipart/form-data` (task F1-06s): no `body` part then, the handler reads
//                  the stream (platform `readSingleUpload`); a marker, never an Ajv schema
//   `properties` maps each name to the parameter's `schema`, unchanged; `required` is always
//   present (possibly empty) and keeps the declaration order, path-item parameters first. There is never a `response` part (it would
//   silently drop fields; responses are checked in tests). Shapes this module does not support
//   throw an Error naming the operation: a `cookie` parameter, a parameter whose schema is an
//   array or an object, a `style` / `explode` / `content` on a parameter, a request body that is
//   not `required: true`, and request content other than exactly `application/json` or exactly
//   `multipart/form-data`.
//
// createValidatorCompiler() → the Fastify `validatorCompiler`
//   Called with { schema, httpPart } (also method and url, unused); returns the compiled
//   validate function (a false result carries Ajv's `errors`). Two Ajv2020 instances, both with
//   `strict: true` and `allErrors: true`: `httpPart` 'body' uses one without type coercion; every
//   other part ('querystring', 'params', 'headers') uses one with `coerceTypes: true` (their
//   values arrive as strings and are converted in place). Formats: ajv-formats, with `int32`
//   (an integer in −2^31 … 2^31−1) and `int64` replaced by this module's own: an integer within
//   ±(2^53 − 1), so an amount that JavaScript cannot hold exactly is refused. Strict mode makes a
//   bad contract fail when the route is compiled (application start): an unknown keyword,
//   `properties` / `unevaluatedProperties` without `type: 'object'`, `prefixItems` without
//   `minItems`, a `required` name that is not in `properties`.
//
// validationErrorEnvelope(error, traceId) → ValidationErrorResponse | undefined
//   For Fastify's validation error (code 'FST_ERR_VALIDATION', `validation`: Ajv errors,
//   `validationContext`: 'body' | 'querystring' | 'params' | 'headers'): HTTP 400 and the
//   contract ErrorEnvelope { code: 20001, msg, data: { fields }, trace_id: traceId }. `fields`
//   names every offending field once, in the order of the Ajv errors: `missingProperty` of a
//   `required` error, `additionalProperty` of an `additionalProperties` error, otherwise the
//   error's instancePath; a name is the path from the part's root, its JSON-pointer segments
//   unescaped (~1 → /, ~0 → ~) and joined with '.', array indexes included (items.0.price). An
//   error at the root of a part with no property (for example a missing body) names the part
//   itself ('body', 'querystring', 'params', 'headers'). An `if` error (Ajv's companion of a
//   failed `then` / `else`, reported at the `if` schema's location) is left out when the same
//   validation has any error with another keyword, which already names the offending field; when
//   only `if` errors remain they are kept, so `fields` is never empty. `msg` is a non-empty fallback text
//   that never repeats a submitted value. Any other error (not FST_ERR_VALIDATION, or without
//   an array `validation`) → undefined: the caller handles it as before.
//
// fieldsErrorEnvelope(fields, traceId) → ValidationErrorResponse
//   The same HTTP 400 / 20001 envelope for a check that runs after the route schema (for example
//   a device hash on the invalid list, BR-ID-09): `data.fields` is a copy of `fields`, `msg` and
//   the status are the ones validationErrorEnvelope uses.
//
// Wiring (bootstrap.ts, covered by the implementer's unit tests through Fastify `inject`): the
// Fastify instance uses createValidatorCompiler(); a global Nest exception filter answers
// FST_ERR_VALIDATION with validationErrorEnvelope and the request's trace id (Nest would answer
// 500); controllers mount route schemas with `@RouteSchema`.
//
// Rules for the implementation: this file is also compiled by the `test` project: erasable syntax
// only (no parameter properties, no enum, no namespace, no decorators), `import type` for
// type-only imports, relative imports with the `.ts` extension, no NestJS import, no
// `process.env`. Allowed packages: ajv, ajv-formats (already dependencies of @couli/api).

import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';

/** A JSON Schema object (draft 2020-12 as used by OAS 3.1). */
export type JsonSchema = { readonly [keyword: string]: unknown };

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/** An OAS 3.1 parameter object after dereferencing. */
export interface ContractParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required?: boolean;
  readonly schema?: JsonSchema;
  readonly style?: string;
  readonly explode?: boolean;
  readonly content?: { readonly [mediaType: string]: unknown };
  readonly [extension: string]: unknown;
}

/** The parts of an OAS 3.1 operation that request validation reads. */
export interface ContractOperation {
  readonly operationId?: string;
  readonly parameters?: readonly ContractParameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: { readonly [mediaType: string]: { readonly schema?: JsonSchema } };
  };
  readonly [field: string]: unknown;
}

/** Fastify route schema: only the request parts, never `response`. */
export interface RouteSchema {
  /** Request-body metadata, not an Ajv schema; the handler consumes the multipart stream. */
  readonly multipart?: true;
  readonly params?: JsonSchema;
  readonly querystring?: JsonSchema;
  readonly headers?: JsonSchema;
  readonly body?: JsonSchema;
}

export type HttpPart = 'body' | 'querystring' | 'params' | 'headers';

/** What Fastify passes to its validatorCompiler. */
export interface ValidatorRoute {
  readonly schema: JsonSchema;
  readonly httpPart?: string;
  readonly method?: string;
  readonly url?: string;
}

/** A compiled validator: true when valid; after false, `errors` holds the Ajv errors. */
export type ValidateFunction = ((data: unknown) => boolean) & {
  errors?: readonly ValidationIssue[] | null;
};

/** The fields of an Ajv error that the envelope reads. */
export interface ValidationIssue {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: { readonly [name: string]: unknown };
  readonly message?: string;
}

export interface ValidationErrorResponse {
  readonly statusCode: 400;
  readonly body: {
    readonly code: 20001;
    readonly msg: string;
    readonly data: { readonly fields: readonly string[] };
    readonly trace_id: string;
  };
}

export function routeSchemaOf(
  operation: ContractOperation,
  pathItemParameters?: readonly ContractParameter[],
): RouteSchema {
  const fail = (reason: string): never => {
    throw new Error(`${operation.operationId ?? '(unnamed operation)'}: ${reason}`);
  };
  const parameters = new Map<string, ContractParameter>();
  for (const parameter of [...(pathItemParameters ?? []), ...(operation.parameters ?? [])]) {
    const name = parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name;
    parameters.set(`${parameter.in}:${name}`, { ...parameter, name });
  }
  const groups = new Map<'params' | 'querystring' | 'headers', ContractParameter[]>();
  for (const parameter of parameters.values()) {
    if (parameter.in === 'cookie' || !['path', 'query', 'header'].includes(parameter.in)) {
      fail(`unsupported parameter location: ${parameter.in}`);
    }
    if (['style', 'explode', 'content'].some((key) => key in parameter)) {
      fail(`unsupported serialization for ${parameter.name}`);
    }
    const schema = parameter.schema;
    if (schema === undefined || hasStructuredType(schema)) {
      fail(`unsupported parameter schema for ${parameter.name}`);
    }
    const part =
      parameter.in === 'path' ? 'params' : parameter.in === 'query' ? 'querystring' : 'headers';
    const group = groups.get(part) ?? [];
    group.push(parameter);
    groups.set(part, group);
  }
  const result: {
    multipart?: true;
    params?: JsonSchema;
    querystring?: JsonSchema;
    headers?: JsonSchema;
    body?: JsonSchema;
  } = {};
  for (const [part, group] of groups) {
    result[part] = {
      type: 'object',
      properties: Object.fromEntries(group.map((parameter) => [parameter.name, parameter.schema])),
      required: group
        .filter((parameter) => part === 'params' || parameter.required === true)
        .map((parameter) => parameter.name),
      ...(part === 'headers' ? {} : { additionalProperties: false }),
    };
  }
  if (operation.requestBody !== undefined) {
    const { required, content } = operation.requestBody;
    const mediaTypes = Object.keys(content ?? {});
    if (required === true && mediaTypes.length === 1 && mediaTypes[0] === 'multipart/form-data') {
      result.multipart = true;
      return result;
    }
    const schema = content?.['application/json']?.schema;
    if (required !== true || Object.keys(content ?? {}).length !== 1 || schema === undefined) {
      return fail(
        'request body must be required and contain only application/json with a schema, or only multipart/form-data',
      );
    }
    result.body = schema;
  }
  return result;
}

function hasStructuredType(schema: JsonSchema): boolean {
  const types = Array.isArray(schema['type']) ? schema['type'] : [schema['type']];
  if (types.includes('array') || types.includes('object')) return true;
  return ['allOf', 'anyOf', 'oneOf'].some((keyword) => {
    const branches = schema[keyword];
    return (
      Array.isArray(branches) && branches.some((branch: JsonSchema) => hasStructuredType(branch))
    );
  });
}

export function createValidatorCompiler(): (
  route: ValidatorRoute,
) => ReturnType<Ajv2020['compile']> {
  const create = (coerceTypes: boolean): Ajv2020 => {
    const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes });
    ajvFormats.default(ajv);
    ajv.addFormat('int32', {
      type: 'number',
      validate: (value: number) =>
        Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
    });
    ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
    return ajv;
  };
  const body = create(false);
  const parameters = create(true);
  return ({ schema, httpPart }) => (httpPart === 'body' ? body : parameters).compile(schema);
}

export function validationErrorEnvelope(
  error: unknown,
  traceId: string,
): ValidationErrorResponse | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'FST_ERR_VALIDATION' ||
    !('validation' in error) ||
    !Array.isArray(error.validation)
  )
    return undefined;

  const part = 'validationContext' in error ? String(error.validationContext) : 'body';
  const issues = error.validation as ValidationIssue[];
  const hasNonIf = issues.some((issue) => issue.keyword !== 'if');
  const fields = new Set<string>();
  for (const issue of issues) {
    if (issue.keyword === 'if' && hasNonIf) continue;
    const segments =
      issue.instancePath === ''
        ? []
        : issue.instancePath
            .slice(1)
            .split('/')
            .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    const property =
      issue.keyword === 'required'
        ? issue.params['missingProperty']
        : issue.keyword === 'additionalProperties'
          ? issue.params['additionalProperty']
          : undefined;
    if (typeof property === 'string') segments.push(property);
    fields.add(segments.length > 0 ? segments.join('.') : part);
  }
  return fieldsErrorEnvelope([...fields], traceId);
}

export function fieldsErrorEnvelope(
  fields: readonly string[],
  traceId: string,
): ValidationErrorResponse {
  return {
    statusCode: 400,
    body: { code: 20001, msg: '参数校验失败', data: { fields: [...fields] }, trace_id: traceId },
  };
}
