// CT-24zzk GET /admin/v1/dashboard（adminGetDashboard）200 响应里 yesterday 的取值（任务书第 9 节第 1–4 条）：
// 恰为完整的 AdminDashboardYesterday 对象或 null，键本身仍 required。独立预期，不从契约生成；
// 静态读 contracts，用仓库现成的 Ajv2020 strict 校验，不连库、不 listen。
import { expect, it } from 'vitest';
import {
  at,
  check,
  compile,
  contract,
  list,
  resolve,
  without,
} from '../admin-order-actions/kit.ts';
import { closed } from '../order-claims/kit.ts';
import {
  countKeys,
  dashboardSchema,
  envelope,
  responseValidator,
  staleYesterday,
  status,
  todo,
  withYesterday,
  yesterday,
  yesterdayKeys,
} from './kit.ts';

it('[AC-CT-24zzk#1] 没有任何聚合行时 yesterday 为 null 合法：有无 status、todo 是否为空都一样', () => {
  const validate = responseValidator(contract());
  check(validate, withYesterday(null), true);
  check(validate, withYesterday(null, true), true);
  check(validate, envelope({ todo: [], yesterday: null }), true);
});

it('[AC-CT-24zzk#2] yesterday 仍是 required 键：缺键不合法（有无 status 都一样）；可空不等于可省，带上 yesterday: null 才合法', () => {
  const doc = contract();
  expect(list(dashboardSchema(doc)['required'])).toContain('yesterday');
  const validate = responseValidator(doc);
  check(validate, envelope({ todo }), false);
  check(validate, envelope({ todo, status }), false);
  check(validate, envelope({ todo: [] }), false);
  check(validate, withYesterday(null), true);
});

it('[AC-CT-24zzk#3] yesterday 恰为完整的 AdminDashboardYesterday 或 null：组件不变，六个字段缺一或多一都不合法，计数 minimum 0 不变', () => {
  const doc = contract();
  // 组件本身不变：闭合对象，六个字段全部 required；组件自身不接受 null（可空只在 AdminDashboard.yesterday 上）。
  const component = resolve(doc, at(doc, 'components', 'schemas', 'AdminDashboardYesterday'));
  closed(component, yesterdayKeys);
  const own = compile(doc, component);
  check(own, yesterday, true);
  check(own, null, false);

  const validate = responseValidator(doc);
  // 完整对象合法；最新一行早于昨天时 date 与 as_of 如实，仍是同一形状。
  for (const value of [yesterday, staleYesterday]) {
    check(validate, withYesterday(value), true);
    check(validate, withYesterday(value, true), true);
  }
  for (const key of yesterdayKeys) check(validate, withYesterday(without(yesterday, key)), false);
  check(validate, withYesterday({ ...yesterday, extra: 1 }), false);
  check(validate, withYesterday({ ...yesterday, open_alerts: 0 }), false);
  for (const key of countKeys) {
    check(validate, withYesterday({ ...yesterday, [key]: 0 }), true);
    for (const bad of [-1, 1.5, '1', null])
      check(validate, withYesterday({ ...yesterday, [key]: bad }), false);
  }
  for (const bad of [1.5, '158600', null])
    check(validate, withYesterday({ ...yesterday, est_rebate_fen: bad }), false);
  for (const bad of ['2026-11-12T00:00:00+08:00', 'yesterday', '', null])
    check(validate, withYesterday({ ...yesterday, date: bad }), false);
  for (const bad of ['2026-11-13', 'today', '', null])
    check(validate, withYesterday({ ...yesterday, as_of: bad }), false);

  // 与完整对象并列的唯一另一种取值：整个 yesterday 为 null。
  check(validate, withYesterday(null), true);
  check(validate, withYesterday(null, true), true);
});

it('[AC-CT-24zzk#4] 除 null 外，yesterday 不接受其它非对象值（0、字符串、空对象、数组、布尔）', () => {
  const validate = responseValidator(contract());
  for (const value of [0, 1, '', 'null', '2026-11-12', {}, [], [yesterday], true, false])
    check(validate, withYesterday(value), false);
  check(validate, withYesterday(null), true);
});
