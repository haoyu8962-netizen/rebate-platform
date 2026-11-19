// B1-02zzzc (编排裁定 D10-1699, D10-1780 ③): helpers for test/spec/identity/step-up-verify/kit.ts,
// which is frozen outside its it blocks and may only take plain inserted calls. The branching that
// lets OPERATIONS.phone (POST /v1/me/phone, bindPhone) go through the same stub as deletion and
// withdraw lives here.
//
// bindPhone's real handler takes @Req() and @Res() and answers through the reply. The stub takes
// @Req() only (its own check stays as it is), so for phone this file removes the @Res() entry from
// the controller's route-argument metadata before Nest registers the route (the kit swaps before
// app.init()): Nest then calls the stub with the request alone, serialises what it returns, and
// answers an HttpException the stub's business throws with that exception's status. Without @Res()
// a POST answers 201 by default, so the stub gets an explicit 200 (as the planned endpoints do).
// Everything is put back by the kit's restore list.

/** reflect-metadata (loaded by @nestjs/common), the three-argument forms Nest uses for route args. */
const metadata = Reflect as unknown as {
  getOwnMetadata(key: unknown, target: object, property?: string): unknown;
  getMetadata(key: unknown, target: object, property?: string): unknown;
  defineMetadata(key: unknown, value: unknown, target: object, property?: string): void;
  deleteMetadata(key: unknown, target: object, property?: string): boolean;
};

const PHONE_BODY = { phone: '13800138000', code: '123456' } as const;

function stringConstant(source: object, name: string): string {
  const value = (source as Record<string, unknown>)[name];
  if (typeof value !== 'string')
    throw new Error(`phone-stub: @nestjs/common/constants has no ${name}`);
  return value;
}

/**
 * The route-argument key prefix Nest uses for @Res(). @nestjs/common does not re-export its
 * RouteParamtypes enum from the package root, so apply the public Res() decorator to a probe method
 * and read back the single key it wrote (`<paramtype>:<index>`).
 */
function responseParamtype(common: object, routeArgs: string): string {
  const res = (common as { Res?: unknown }).Res;
  if (typeof res !== 'function') throw new Error('phone-stub: @nestjs/common has no Res');
  class Probe {
    method(): void {}
  }
  (res as () => (target: object, name: string, index: number) => void)()(
    Probe.prototype,
    'method',
    0,
  );
  const keys = Object.keys(
    (metadata.getOwnMetadata(routeArgs, Probe, 'method') ?? {}) as Record<string, unknown>,
  );
  const prefix = keys.length === 1 ? keys[0]?.split(':')[0] : undefined;
  if (prefix === undefined || prefix === '')
    throw new Error('phone-stub: cannot read the @Res() route-argument key');
  return prefix;
}

/**
 * Called by the kit right after it copied the real method's metadata onto the stub. Does nothing
 * unless the operation is phone.
 */
export function detachPhoneReply(options: {
  readonly name: string;
  readonly metatype: object;
  readonly method: string;
  readonly stub: object;
  readonly restore: (() => void)[];
  readonly constants: object;
  readonly common: object;
}): void {
  const { name, metatype, method, stub, restore, constants, common } = options;
  if (name !== 'phone') return;
  const routeArgs = stringConstant(constants, 'ROUTE_ARGS_METADATA');
  const httpCode = stringConstant(constants, 'HTTP_CODE_METADATA');
  const response = responseParamtype(common, routeArgs);

  const hadOwn = metadata.getOwnMetadata(routeArgs, metatype, method);
  const current = (metadata.getMetadata(routeArgs, metatype, method) ?? {}) as Record<
    string,
    unknown
  >;
  const kept = Object.fromEntries(
    Object.entries(current).filter(([key]) => key.split(':')[0] !== response),
  );
  if (Object.keys(kept).length === Object.keys(current).length)
    throw new Error(`phone-stub: ${method} has no @Res() argument to detach`);
  metadata.defineMetadata(routeArgs, kept, metatype, method);
  metadata.defineMetadata(httpCode, 200, stub);
  restore.push(() => {
    if (hadOwn === undefined) metadata.deleteMetadata(routeArgs, metatype, method);
    else metadata.defineMetadata(routeArgs, hadOwn, metatype, method);
  });
}

/**
 * Called first in User.send: a phone request without a body gets the contract-valid
 * BindPhoneRequest body (the kit's own default, { fixture: operation }, is not one). Fills the
 * options object in place; any other operation, or a given body, is left as it is.
 */
export function fillPhoneBody(
  operation: string,
  options: { readonly body?: Record<string, unknown> },
): void {
  if (operation !== 'phone' || options.body !== undefined) return;
  (options as { body?: Record<string, unknown> }).body = { ...PHONE_BODY };
}
