// B1-25a: BR-WDR-24 / BR-WDR-26 and the supplied D10-714 / D10-716 routing decision.
// AC-B1-25a identifiers are local acceptance points (the task has no pre-existing AC IDs).
// Tests cover config delivery eligibility, not payout detection, user notifications or a real sink.
import { expect, it } from 'vitest';
import {
  alerts,
  configuration,
  keys,
  list,
  notifications,
  record,
  selected,
  string,
} from './kit.ts';

const TIMES = [
  '00:00:00',
  '07:59:00',
  '07:59:59',
  '08:00:00',
  '12:00:00',
  '21:59:59',
  '22:00:00',
  '23:00:00',
];

it.each(TIMES)('[AC-B1-25a#1] 所有真实资金告警在 +08:00 %s 同时到 finance 与 oncall', (time) => {
  const config = configuration();
  for (const labels of alerts('fund')) {
    expect(notifications(config, labels, `2031-04-05T${time}+08:00`), labels['alertname']).toEqual([
      'finance',
      'oncall',
    ]);
  }
});

it.each(TIMES)('[AC-B1-25a#2] 真实运维告警在 +08:00 %s 按 [22:00,08:00) 静默', (time) => {
  const config = configuration();
  const quiet = time >= '22:00:00' || time < '08:00:00';
  for (const labels of alerts('ops')) {
    expect(notifications(config, labels, `2031-04-05T${time}+08:00`), labels['alertname']).toEqual(
      quiet ? [] : ['oncall'],
    );
  }
});

it('[AC-B1-25a#3] 持续触发的运维告警跨夜后恢复 oncall 资格，每天都在上海时区静默', () => {
  const config = configuration();
  for (const labels of alerts('ops')) {
    const routes = selected(config, labels);
    expect(routes.map((route) => route.receiver)).toEqual(['oncall']);
    expect(routes.flatMap((route) => route.mute).length, 'use quiet-hour muting').toBeGreaterThan(
      0,
    );
    for (const name of routes.flatMap((route) => route.mute)) {
      for (const span of config.intervals.get(name)!)
        expect(span['location']).toBe('Asia/Shanghai');
    }
    // Same labels throughout, no re-fire needed; includes weekdays/weekend and UTC date rollover.
    // Actual sending is on the next group_interval after 08:00, not an exact 08:00 cron guarantee.
    for (const day of ['05', '06', '07', '08', '09', '10', '11']) {
      for (const time of TIMES) {
        const quiet = time >= '22:00:00' || time < '08:00:00';
        expect(notifications(config, labels, `2031-04-${day}T${time}+08:00`)).toEqual(
          quiet ? [] : ['oncall'],
        );
      }
    }
    expect(notifications(config, labels, '2031-04-12T08:30:00+08:00')).toEqual(['oncall']);
  }
});

it('[AC-B1-25a#4] 同类告警按 alertname 与 app_id 分组，两个资金接收组及运维组均每 30m 合并', () => {
  const config = configuration();
  for (const kind of ['fund', 'ops'] as const) {
    for (const appId of ['couli', 'alerting_other_app']) {
      for (const labels of alerts(kind, appId)) {
        const routes = selected(config, labels);
        expect(routes.map((route) => route.receiver).sort()).toEqual(
          kind === 'fund' ? ['finance', 'oncall'] : ['oncall'],
        );
        for (const route of routes) {
          expect(route.groupBy, `${labels['alertname']} → ${route.receiver}`).toEqual(
            expect.arrayContaining(['alertname', 'app_id']),
          );
          expect(route.groupBy).not.toContain('...');
          expect(route.groupInterval).toBe('30m');
        }
      }
    }
  }
});

it('[AC-B1-25a#5] 接收组只允许 127.0.0.1 日志占位 webhook，不配置任何外部通知渠道', () => {
  const config = configuration();
  for (const receiver of config.receivers) {
    keys(receiver, ['name', 'webhook_configs'], 'no email, SMS, WeCom or other integrations');
    const hooks = list(receiver['webhook_configs'], 'webhook_configs');
    expect(hooks.length).toBeGreaterThan(0);
    for (const value of hooks) {
      const hook = record(value, 'webhook');
      keys(
        hook,
        ['url', 'send_resolved', 'max_alerts', 'http_config'],
        'placeholder webhook fields',
      );
      const raw = string(hook['url'], 'webhook URL');
      expect(() => new URL(raw)).not.toThrow();
      const url = new URL(raw);
      expect(url.hostname).toBe('127.0.0.1');
      expect(['http:', 'https:']).toContain(url.protocol);
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      // No proxy, authorization or alternate remote endpoint through HTTP configuration.
      const http = record(hook['http_config'] ?? {}, 'http_config');
      keys(http, ['follow_redirects', 'enable_http2'], 'local sink HTTP settings');
      for (const value of Object.values(http)) expect(typeof value).toBe('boolean');
      if (hook['send_resolved'] !== undefined) expect(typeof hook['send_resolved']).toBe('boolean');
      if (hook['max_alerts'] !== undefined) {
        expect(Number.isInteger(hook['max_alerts'])).toBe(true);
        expect(hook['max_alerts']).toBeGreaterThanOrEqual(0);
      }
    }
  }
});

it('[AC-B1-25a#6] 分流前提：couli-fund.yaml 每条规则都有字符串 fund=true，并由此路由到双组', () => {
  const config = configuration();
  for (const labels of alerts('fund')) {
    expect(labels['fund'], labels['alertname']).toBe('true');
    expect(notifications(config, labels, '2031-04-05T23:00:00+08:00')).toEqual([
      'finance',
      'oncall',
    ]);
  }
  for (const labels of alerts('ops')) expect(labels['fund'], labels['alertname']).not.toBe('true');
});

it('[AC-B1-25a#7] BR-WDR-26 审核超时与 BR-WDR-24 结果未知告警在夜间仍通知财务和值班', () => {
  const config = configuration();
  const fund = alerts('fund');
  for (const name of ['CouliWithdrawalReviewOverdue', 'CouliWithdrawalResultUnknown']) {
    const matching = fund.filter((labels) => labels['alertname'] === name);
    expect(matching, `real rule ${name}`).toHaveLength(1);
    for (const labels of matching) {
      expect(notifications(config, labels, '2031-04-05T23:00:00+08:00')).toEqual([
        'finance',
        'oncall',
      ]);
      expect(notifications(config, labels, '2031-04-06T07:59:00+08:00')).toEqual([
        'finance',
        'oncall',
      ]);
    }
  }
});

it('[AC-B1-25a#8] fund 精确等于 true 才豁免静默，不能用告警名或 critical 严重度替代', () => {
  const config = configuration();
  // Keep real alert names/labels, varying only the routing label to isolate the classification.
  for (const labels of [...alerts('fund'), ...alerts('ops')]) {
    const withoutFund = { ...labels };
    delete withoutFund['fund'];
    for (const nonFund of [
      withoutFund,
      { ...labels, fund: 'false' },
      { ...labels, fund: 'TRUE' },
    ]) {
      expect(notifications(config, nonFund, '2031-04-05T12:00:00+08:00')).toEqual(['oncall']);
      expect(notifications(config, nonFund, '2031-04-05T23:00:00+08:00')).toEqual([]);
    }
    expect(notifications(config, { ...labels, fund: 'true' }, '2031-04-05T23:00:00+08:00')).toEqual(
      ['finance', 'oncall'],
    );
  }
});
