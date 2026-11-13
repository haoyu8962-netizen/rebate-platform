import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema, tokenPrincipal } from '../../../platform/index.ts';
import { EventIntakeService } from '../../application/event-intake.ts';

type IngestEventsResponse = Schema<'IngestEventsResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface IngestEventsHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'IngestEventsRequest'>;
}

function header(request: IngestEventsHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Contract operation `ingestEvents` (B1-06zo; BR-ATTR-21, D10-1469 / D10-1470 / D10-1471): x-auth
 * optional, not signed, not idempotent, version gated. The route schema rejects a malformed batch
 * (not an object, events missing / not an array / over 100, another top-level field) with 20001;
 * each event is then checked on its own by the use case. The user comes only from the verified
 * token principal (a guest is null), the app from the principal or else X-App-Id, the device from
 * X-Device-Id (CT-13g); identity fields inside the events are never read.
 *
 * Nest's decorators are applied as plain calls below (not decorator syntax), as for the open.
 */
export class IngestEventsController {
  readonly #intake: EventIntakeService;

  constructor(intake: EventIntakeService) {
    this.#intake = intake;
  }

  async ingest(request: IngestEventsHttpRequest): Promise<IngestEventsResponse> {
    const principal = tokenPrincipal(request);
    const { droppedCount } = await this.#intake.ingest(
      {
        appId: principal?.app_id ?? header(request, 'x-app-id'),
        userId: principal?.uid ?? null,
        // Required by the contract: the route schema rejects a batch without X-Device-Id (20001).
        deviceId: header(request, 'x-device-id'),
      },
      request.body.events,
    );
    return {
      code: 0,
      msg: '',
      data: { dropped_count: droppedCount },
      // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
      trace_id: header(request, 'x-trace-id') || request.id,
    } as IngestEventsResponse;
  }
}

{
  const prototype = IngestEventsController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'ingest')!;
  Inject(EventIntakeService)(IngestEventsController, undefined, 0);
  Req()(prototype, 'ingest', 0);
  Post('events')(prototype, 'ingest', descriptor);
  HttpCode(200)(prototype, 'ingest', descriptor);
  RouteSchema(contractRouteSchema('ingestEvents'))(prototype, 'ingest', descriptor);
  Controller('v1')(IngestEventsController);
}
