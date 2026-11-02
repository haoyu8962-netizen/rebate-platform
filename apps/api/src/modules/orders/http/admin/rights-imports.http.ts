// B1-09g: the handlers of POST / GET /admin/v1/rights-imports and GET
// /admin/v1/rights-imports/{import_id} (contract adminCreateRightsImport / adminListRightsImports /
// adminGetRightsImport). No Nest decorator here: rights-imports.controller.ts (B1-10n) mounts it on
// the admin entry. The admin request check has verified the admin token before these run.
//
// create: the operation guard checks the account and permission point order.claim (no step-up tier)
// first; only inside its callback is the multipart body read (so a refused account never consumes
// it), under this route's own part counts (kind, platform, time_basis, from, to, union_account_id
// and one file; the admin entry's default is one file and no field) passed through the plugin's
// public per-request option `request.parts({ limits })` (F1-09t: no private plugin symbol;
// fileSize stays the global bodyLimit). A body above the route's bodyLimit (Content-Length up
// front, or the bytes counted while streaming) is HTTP 413 / 20001 [body]; a body that is not
// multipart, or malformed, is 400 / 20001. kind=channel then goes through
// the guard a second time with permission point risk.blocklist (totp tier: a valid totp
// X-Step-Up-Token, once for the whole file, BR-ATTR-26 细则「渠道单导入」) before anything is
// stored; rights and punish need neither. The use case (application/rights-imports.ts) answers the
// rest; 20001 is HTTP 400 with data.fields. Success: HTTP 200 { code 0, data { import_id, status
// queued } }.
// list / detail: read-only guard on order.claim (no step-up); the app is the actor's.
import { HttpException } from '@nestjs/common';
import type { Schema } from '@couli/contracts-ts';
import {
  fieldsErrorEnvelope,
  type AdminActor,
  type AdminOperationGuard,
  type SingleUploadRequest,
} from '../../../platform/index.ts';
import {
  createRightsImport,
  getRightsImport,
  listRightsImports,
  type RightsImportDeps,
  type RightsImportPageQuery,
} from '../../application/rights-imports.ts';
import { RightsImportPartsRejection, readRightsImportParts } from './rights-import-parts.ts';

/** The admin entry's Fastify request (multipart methods installed on the admin entry). */
export interface RightsImportRequest extends SingleUploadRequest {
  readonly ip?: string;
  /** The plugin's public reader with per-request busboy counts. */
  parts(options?: { readonly limits?: object }): ReturnType<SingleUploadRequest['parts']>;
}

/** Any admin request: its id is the trace id. */
export interface RightsImportReadRequest {
  readonly id: string;
  readonly ip?: string;
}

export interface AdminRightsImportsDeps {
  readonly guard: Pick<AdminOperationGuard, 'run'>;
  readonly imports: RightsImportDeps;
}

/** HTTP 400 (or the given status) with 20001 data.fields, written back by the global filter. */
function fieldsRefusal(fields: readonly string[], traceId: string, status = 400): HttpException {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return new HttpException(refused.body, status === 400 ? refused.statusCode : status);
}

interface Envelope<T> {
  code: 0;
  msg: string;
  data: T;
  trace_id: string;
}

export class AdminRightsImportsHttp {
  readonly #guard: Pick<AdminOperationGuard, 'run'>;
  readonly #imports: RightsImportDeps;

  constructor(deps: AdminRightsImportsDeps) {
    this.#guard = deps.guard;
    this.#imports = deps.imports;
  }

  async create(request: RightsImportRequest): Promise<Schema<'AdminRightsImportCreateResponse'>> {
    let response: Schema<'AdminRightsImportCreateResponse'> | undefined;
    const accept = async (actor: AdminActor, parts: Awaited<ReturnType<typeof readParts>>) => {
      const outcome = await createRightsImport(
        this.#imports,
        { appId: actor.appId, adminId: actor.adminId, ip: request.ip ?? null },
        { ...parts.fields, file: parts.file },
      );
      if (outcome.code !== 0) throw fieldsRefusal(outcome.data.fields, request.id);
      response = { code: 0, msg: '', data: outcome.data, trace_id: request.id };
      return { statusCode: 200, body: response };
    };
    await this.#guard.run({ request, permission: 'order.claim' }, async (actor) => {
      const parts = await readParts(request);
      if (parts.invalid.length > 0) throw fieldsRefusal([parts.invalid[0]!], request.id);
      if (parts.fields.kind !== 'channel') return accept(actor, parts);
      // A channel import: risk.blocklist and its totp step-up, once for the whole file.
      return this.#guard.run({ request, permission: 'risk.blocklist' }, (again) =>
        accept(again, parts),
      );
    });
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }

  list(
    request: RightsImportReadRequest,
    query: RightsImportPageQuery,
  ): Promise<Schema<'AdminRightsImportPageResponse'>> {
    return this.#read(request, (appId) => listRightsImports(this.#imports, appId, query));
  }

  detail(
    request: RightsImportReadRequest,
    importId: string,
  ): Promise<Schema<'AdminRightsImportDetailResponse'>> {
    return this.#read(request, async (appId) => {
      const outcome = await getRightsImport(this.#imports, appId, importId);
      if (outcome.code !== 0) throw fieldsRefusal(outcome.data.fields, request.id);
      return outcome.data;
    });
  }

  async #read<T>(
    request: RightsImportReadRequest,
    read: (appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: 'order.claim', readOnly: true }, async (actor) => {
      response = { code: 0, msg: '', data: await read(actor.appId), trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }
}

/** The parts, a refused body turned into its 20001 envelope (400 / 413, data.fields [body]). */
async function readParts(request: RightsImportRequest) {
  try {
    return await readRightsImportParts(request);
  } catch (error) {
    if (!(error instanceof RightsImportPartsRejection)) throw error;
    throw fieldsRefusal(['body'], request.id, error.statusCode);
  }
}
