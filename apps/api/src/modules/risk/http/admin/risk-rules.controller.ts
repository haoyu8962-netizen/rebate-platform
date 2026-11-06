// B1-03zg: the console's risk rule list (规则清单) and enable / disable (CT-24f) — GET
// /admin/v1/risk-rules (adminListRiskRules), POST /admin/v1/risk-rules/{rule_id}/enable
// (adminEnableRiskRule) and …/disable (adminDisableRiskRule). Mounted only by
// RiskRulesAdminModule on the admin entry. The admin request check has verified the admin_token
// and the route schema the path and body before this runs; the operation guard checks the
// account and the permission point config.risk: the list read only (no step-up; an
// X-Step-Up-Token header is ignored), enable / disable with its totp step-up on every call, the
// step-up token consumed only after a 200 with code 0. Refusals are thrown inside the guard so a
// refused change never uses up the token. No Idempotency-Key (04 §6.6): the version
// compare-and-set makes a stale repeat a 20902.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminRiskRuleConflictError,
  AdminRiskRules,
  AdminRiskRulesFieldsError,
  type AdminRiskRuleChange,
} from '../../application/admin-risk-rules.ts';

interface RiskRulesRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

const PERMISSION = 'config.risk';

type ChangeBody = Schema<'AdminRiskRuleStatusChangeRequest'>;
type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

export class AdminRiskRulesController {
  readonly #guard: AdminOperationGuard;
  readonly #rules: AdminRiskRules;

  constructor(guard: AdminOperationGuard, rules: AdminRiskRules) {
    this.#guard = guard;
    this.#rules = rules;
  }

  list(request: RiskRulesRequest): Promise<Schema<'AdminRiskRuleListResponse'>> {
    return this.run(request, true, async (actor) => ({
      items: await this.#rules.list(actor.appId),
    }));
  }

  enable(
    request: RiskRulesRequest,
    ruleId: string,
    body: ChangeBody,
  ): Promise<Schema<'AdminRiskRuleResponse'>> {
    return this.change(request, ruleId, body, 'enable');
  }

  disable(
    request: RiskRulesRequest,
    ruleId: string,
    body: ChangeBody,
  ): Promise<Schema<'AdminRiskRuleResponse'>> {
    return this.change(request, ruleId, body, 'disable');
  }

  private change(
    request: RiskRulesRequest,
    ruleId: string,
    body: ChangeBody,
    change: AdminRiskRuleChange,
  ): Promise<Schema<'AdminRiskRuleResponse'>> {
    return this.run(request, false, (actor) =>
      this.#rules.change({
        appId: actor.appId,
        adminId: actor.adminId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        ruleId,
        change,
        body,
      }),
    );
  }

  private async run<T>(
    request: RiskRulesRequest,
    readOnly: boolean,
    business: (actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: PERMISSION, readOnly }, async (actor) => {
      try {
        const data = await business(actor);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('risk: admin guard returned without an answer');
    return response;
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminRiskRulesFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof AdminRiskRuleConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '规则已被修改，请刷新后重试',
        data: { resource: 'risk_rule' },
        trace_id: traceId,
      },
      409,
    );
  }
  return error;
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminRiskRulesController.prototype;
  Inject(AdminOperationGuard)(AdminRiskRulesController, undefined, 0);
  Inject(AdminRiskRules)(AdminRiskRulesController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListRiskRules'))(prototype, 'list', list);
  for (const [method, operationId] of [
    ['enable', 'adminEnableRiskRule'],
    ['disable', 'adminDisableRiskRule'],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    Req()(prototype, method, 0);
    Param('rule_id')(prototype, method, 1);
    Body()(prototype, method, 2);
    Post(`:rule_id/${method}`)(prototype, method, descriptor);
    HttpCode(200)(prototype, method, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, method, descriptor);
  }
  Controller('admin/v1/risk-rules')(AdminRiskRulesController);
}
