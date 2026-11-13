// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  APPROVE,
  ENTRY,
  ID,
  REASONS,
  REJECT,
  REVIEW,
  SUBMIT,
  VERIFY,
  actions,
  assertRequest,
  button,
  choose,
  click,
  confirm,
  dialogs,
  disabled,
  failure,
  fill,
  fixture,
  main,
  mount,
  noteField,
  notices,
  ok,
  open,
  pathFor,
  refreshed,
  serverFor,
  settle,
  settled,
  start,
  step,
  stepDialogs,
  succeed,
  verify,
  writes,
  type Action,
} from './helpers.ts';

it(
  '[AC-F1-08ah-ENTRY#1] 待审核且持 withdraw.review 或超管才出现可用审核入口；只读及打款权限不能替代审核权限',
  { timeout: 90_000 },
  async () => {
    for (const permissions of [
      { isSuper: false, permissions: ['fund.view'] },
      { isSuper: false, permissions: ['fund.view', 'payout.execute', 'payout.manual_entry'] },
      { isSuper: false, permissions: ['fund.view', 'user.lookup'] },
    ]) {
      const server = serverFor();
      await mount(server, permissions);
      expect(actions(main(), ENTRY.approve)).toEqual([]);
      expect(actions(main(), ENTRY.reject)).toEqual([]);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    for (const permissions of [REVIEW, { isSuper: true, permissions: [] }]) {
      const server = serverFor();
      await mount(server, permissions);
      expect(disabled(button(main(), ENTRY.approve))).toBe(false);
      expect(disabled(button(main(), ENTRY.reject))).toBe(false);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ah-ENTRY#2] 以真实状态决定显隐：APPROVED 仅可驳回；打款中、成功、失败、已驳回均无入口；待审可审核且不提前触发打款',
  { timeout: 90_000 },
  async () => {
    for (const status of ['PAYING', 'PAID_API', 'PAID_MANUAL', 'FAILED', 'REJECTED'] as const) {
      const server = serverFor(fixture(status));
      await mount(server);
      expect(actions(main(), ENTRY.approve), status).toEqual([]);
      expect(actions(main(), ENTRY.reject), status).toEqual([]);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    const approved = serverFor(fixture('APPROVED'));
    await mount(approved);
    expect(actions(main(), ENTRY.approve)).toEqual([]);
    expect(disabled(button(main(), ENTRY.reject))).toBe(false);
    cleanup();
    const pending = serverFor();
    await mount(pending, { isSuper: true, permissions: [] });
    expect(disabled(button(main(), ENTRY.approve))).toBe(false);
    expect(disabled(button(main(), ENTRY.reject))).toBe(false);
    expect(actions(main(), /执行打款|手动成功|撤销微信转账|重新计算/)).toEqual([]);
    expect(pending.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08ah-APPROVE#1] 确认再验动态码，只批量通过当前一张，body 不带行版本；收到成功后 GET 新状态，保留驳回入口',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', APPROVE, () => succeed(server, 'approve'));
    await mount(server);
    const before = server.detailReads(ID.pending).length;
    const modal = await open('approve');
    expect(server.writes()).toEqual([]);
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    assertRequest(server, 'approve', { withdrawal_ids: [ID.pending] });
    await refreshed(server, before, /已通过待打款/);
    expect(disabled(button(main(), ENTRY.reject))).toBe(false);
    expect(server.log.indexOf(server.detailReads(ID.pending).at(-1)!)).toBeGreaterThan(
      server.log.indexOf(writes(server)[0]!),
    );
  },
);

it(
  '[AC-F1-08ah-APPROVE#2] 批量接口 HTTP 成功但当前单 skipped：四种原因分别提示，不能误报审核成功；not_pending 刷新状态',
  { timeout: 90_000 },
  async () => {
    const cases = [
      { reason: 'not_found', message: /不存在|未找到|not_found/ },
      { reason: 'not_pending', message: /状态.*(?:变|更新)|不.*待审|已.*审核|not_pending/ },
      { reason: 'negative_balance', message: /余额.*(?:负|不足)|negative_balance/ },
      { reason: 'blocked', message: /阻断|受阻|暂停|blocked/ },
    ];
    for (const one of cases) {
      const server = serverFor();
      server.once('POST', APPROVE, () => {
        if (one.reason === 'not_pending') server.state[0]!.status = 'APPROVED';
        return ok({
          items: [{ withdrawal_id: ID.pending, result: 'skipped', reason: one.reason }],
        });
      });
      await mount(server);
      const before = server.detailReads(ID.pending).length;
      await start(server, 'approve');
      await verify();
      await waitFor(() => expect(notices()).toMatch(one.message));
      expect(notices()).not.toMatch(/审核成功|审核通过成功|已成功通过/);
      assertRequest(server, 'approve', { withdrawal_ids: [ID.pending] });
      if (one.reason === 'not_pending') await refreshed(server, before, /已通过待打款/);
      await settled(server);
      expect(writes(server)).toHaveLength(1);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ah-REJECT#1] 五个人工原因 Radio 必选，每项展示用户文案，系统码不可选；空选确认不验证不提交，选择后才进入动态码',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    await mount(server);
    const modal = await open('reject');
    const radios = within(modal).queryAllByRole('radio');
    expect(radios).toHaveLength(5);
    for (const row of REASONS) {
      const radio = radios.find(
        (node) =>
          (node instanceof HTMLInputElement && node.value === row.code) ||
          row.name.test(
            node.closest('label')?.textContent ?? node.getAttribute('aria-label') ?? '',
          ),
      );
      expect(radio, row.code).toBeDefined();
      expect(modal.textContent).toContain(row.text);
    }
    expect(modal.textContent).not.toMatch(/NEGATIVE_BALANCE|余额为负|冻结金额已用于抵扣/);
    expect(
      radios.every((node) =>
        node instanceof HTMLInputElement
          ? !node.checked
          : node.getAttribute('aria-checked') !== 'true',
      ),
    ).toBe(true);
    await click(button(modal, SUBMIT));
    expect(server.writes()).toEqual([]);
    expect(stepDialogs()).toEqual([]);
    expect(dialogs()).toContain(modal);
    await choose(modal, 'OTHER');
    await confirm(server, modal);
    expect(writes(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08ah-REJECT#2] 待审与已通过均可驳回，五种原因准确编码；备注可选，USER_REQUEST 必带备注；成功重新 GET',
  { timeout: 90_000 },
  async () => {
    for (const row of REASONS) {
      const server = serverFor(
        fixture(row.code === 'USER_REQUEST' ? 'APPROVED' : 'PENDING_REVIEW'),
      );
      server.once('POST', REJECT, () => succeed(server, 'reject', row.code));
      await mount(server);
      const before = server.detailReads(ID.pending).length;
      const modal = await open('reject');
      await choose(modal, row.code);
      if (row.code === 'USER_REQUEST') await fill(noteField(modal), '客服记录：本人申请取消');
      await confirm(server, modal);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      assertRequest(
        server,
        'reject',
        row.code === 'USER_REQUEST'
          ? { reason_code: row.code, note: '客服记录：本人申请取消' }
          : { reason_code: row.code },
      );
      await refreshed(server, before, /已驳回/);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ah-NOTE#1] USER_REQUEST 缺备注或纯空白不可提交，补上非空备注后才验动态码',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    await mount(server);
    const modal = await open('reject');
    await choose(modal, 'USER_REQUEST');
    for (const value of ['', '   \n\t']) {
      await fill(noteField(modal), value);
      await click(button(modal, SUBMIT));
      expect(server.writes()).toEqual([]);
      expect(stepDialogs()).toEqual([]);
      expect(dialogs()).toContain(modal);
    }
    await fill(noteField(modal), '用户确认撤销');
    await confirm(server, modal);
  },
);

it(
  '[AC-F1-08ah-NOTE#2] 内部备注按 Unicode 码点限 500：500 个非 BMP 字符完整送出，不能按 UTF-16 截半',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', REJECT, () => succeed(server, 'reject'));
    await mount(server);
    const modal = await open('reject');
    await choose(modal, 'OTHER');
    const note = '𠮷'.repeat(500);
    await fill(noteField(modal), note);
    await confirm(server, modal);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(1));
    assertRequest(server, 'reject', { reason_code: 'OTHER', note });
  },
);

it(
  '[AC-F1-08ah-NOTE#3] 501 码点备注不能提交，改到 500 码点可确认；不静默截断用户备注',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    await mount(server);
    const modal = await open('reject');
    await choose(modal, 'OTHER');
    await fill(noteField(modal), '𠮷'.repeat(501));
    await click(button(modal, SUBMIT));
    expect(server.writes()).toEqual([]);
    expect(stepDialogs()).toEqual([]);
    expect(notices()).toMatch(/500|过长|超出|超过/);
    await fill(noteField(modal), '𠮷'.repeat(500));
    await confirm(server, modal);
  },
);

it(
  '[AC-F1-08ah-SUBMIT#1] 两种操作连点确认、验证以及请求在途再次点击只提交一次；提交中保留原对话框并禁用提交按钮',
  { timeout: 90_000 },
  async () => {
    for (const action of ['approve', 'reject'] as const) {
      const server = serverFor();
      const release = server.hold('POST', pathFor(action), () => succeed(server, action));
      await mount(server);
      try {
        const modal = await open(action);
        if (action === 'reject') await choose(modal, 'OTHER');
        const submit = button(modal, SUBMIT);
        await confirm(server, modal, true);
        await verify(true);
        await waitFor(() => expect(writes(server)).toHaveLength(1));
        await waitFor(() => expect(disabled(submit)).toBe(true));
        expect(dialogs()).toContain(modal);
        await click(submit, true);
        expect(writes(server)).toHaveLength(1);
        expect(server.requests('POST', VERIFY)).toHaveLength(1);
      } finally {
        release();
      }
      await settled(server);
      assertRequest(
        server,
        action,
        action === 'approve' ? { withdrawal_ids: [ID.pending] } : { reason_code: 'OTHER' },
      );
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ah-CANCEL#1] 两种确认对话框取消后焦点回触发按钮，动态码取消不提交；重新操作仍需验证',
  { timeout: 90_000 },
  async () => {
    for (const action of ['approve', 'reject'] as const) {
      const server = serverFor();
      await mount(server);
      const entry = button(main(), ENTRY[action]);
      const modal = await open(action);
      await click(button(modal, /^取消$/));
      await waitFor(() => expect(dialogs()).toEqual([]));
      await waitFor(() => expect(document.activeElement).toBe(entry));
      expect(server.writes()).toEqual([]);
      await start(server, action);
      await click(button(await step(), /^取消$/));
      await waitFor(() => expect(stepDialogs()).toEqual([]));
      expect(server.writes()).toEqual([]);
      // Implementations may keep the confirmation open when step-up is cancelled.
      for (const remaining of dialogs()) await click(button(remaining, /^取消$/));
      await waitFor(() => expect(document.activeElement).toBe(entry));
      await start(server, action);
      expect(writes(server)).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ah-ERROR#1] 驳回返回 20902 提示状态变化并刷新，不自动重发；状态已驳回后隐藏入口',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', REJECT, () => {
      server.state[0]!.status = 'REJECTED';
      server.state[0]!.display_status = 'rejected';
      return failure(20902, { resource: 'withdrawal' });
    });
    await mount(server);
    const before = server.detailReads(ID.pending).length;
    await start(server, 'reject');
    await verify();
    await waitFor(() => expect(notices()).toMatch(/状态.*(?:变|更新)|已被.*处理|刷新|冲突/));
    await refreshed(server, before, /已驳回/);
    expect(writes(server)).toHaveLength(1);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08ah-ERROR#2] 两种操作返回 10003 重新要动态码，等待期间不重发；验证后新凭据、原幂等标识和原 body 提交',
  { timeout: 90_000 },
  async () => {
    for (const action of ['approve', 'reject'] as const) {
      const server = serverFor();
      server.once('POST', pathFor(action), () => failure(10003, { tier: 'totp' }));
      server.once('POST', pathFor(action), () => succeed(server, action));
      await mount(server);
      const before = server.detailReads(ID.pending).length;
      await start(server, action);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await step();
      await settled(server);
      expect(writes(server)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(2));
      const sent = writes(server);
      expect(sent[0]!.headers.get('X-Step-Up-Token')).toBe('review-pass-1');
      expect(sent[0]!.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/\S/));
      expect(sent[1]!.headers.get('Idempotency-Key')).toBe(sent[0]!.headers.get('Idempotency-Key'));
      expect(sent[1]!.body).toEqual(sent[0]!.body);
      assertRequest(
        server,
        action,
        action === 'approve' ? { withdrawal_ids: [ID.pending] } : { reason_code: 'OTHER' },
        2,
      );
      await refreshed(server, before, action === 'approve' ? /已通过待打款/ : /已驳回/);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ah-ERROR#3] 10403 提示无权限；20001 按 fields 与 reason 区分备注、无此单、已有转账、先查询、查询已成功，不误报成功或重发',
  { timeout: 90_000 },
  async () => {
    const cases: { action: Action; code: number; data: unknown; shown: RegExp }[] = [
      {
        action: 'approve',
        code: 10403,
        data: { reason: 'admin_permission_denied' },
        shown: /无权限|没有.*权限|权限不足/,
      },
      {
        action: 'reject',
        code: 10403,
        data: { reason: 'admin_permission_denied' },
        shown: /无权限|没有.*权限|权限不足/,
      },
      {
        action: 'approve',
        code: 20001,
        data: { fields: ['withdrawal_ids'] },
        shown: /提现单|withdrawal_ids/,
      },
      { action: 'reject', code: 20001, data: { fields: ['note'] }, shown: /备注|note/ },
      {
        action: 'reject',
        code: 20001,
        data: { fields: ['withdrawal_id'] },
        shown: /不存在|未找到|找不到|无此/,
      },
      {
        action: 'reject',
        code: 20001,
        data: { fields: ['withdrawal_id'], reason: 'reject_attempt_exists' },
        shown: /转账.*(?:记录|尝试|存在)|已有.*转账|reject_attempt_exists/,
      },
      {
        action: 'reject',
        code: 20001,
        data: { fields: ['withdrawal_id'], reason: 'reject_query_required' },
        shown: /(?:先|需要|请).*查询|reject_query_required/,
      },
      {
        action: 'reject',
        code: 20001,
        data: { fields: ['withdrawal_id'], reason: 'reject_query_success' },
        shown: /查询.*成功|已经?打款|已经?到账|reject_query_success/,
      },
    ];
    for (const one of cases) {
      const server = serverFor();
      server.once('POST', pathFor(one.action), () => failure(one.code, one.data));
      await mount(server);
      await start(server, one.action);
      await verify();
      await waitFor(() => expect(notices()).toMatch(one.shown));
      expect(notices()).not.toMatch(/审核成功|驳回成功|操作成功/);
      await settled(server);
      expect(writes(server)).toHaveLength(1);
      expect(server.requests('POST', VERIFY)).toHaveLength(1);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ah-STEPUP#1] 审核通过后再驳回是新操作：再次动态码，换幂等标识，不沿用上次凭据',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    server.once('POST', APPROVE, () => succeed(server, 'approve'));
    server.once('POST', REJECT, () => succeed(server, 'reject'));
    await mount(server);
    await start(server, 'approve');
    await verify();
    await refreshed(server, 1, /已通过待打款/);
    await waitFor(() => expect(dialogs()).toEqual([]));
    await start(server, 'reject');
    expect(writes(server)).toHaveLength(1);
    await verify();
    await waitFor(() => expect(writes(server)).toHaveLength(2));
    const sent = writes(server);
    expect(sent.map((r) => r.headers.get('X-Step-Up-Token'))).toEqual([
      'review-pass-1',
      'review-pass-2',
    ]);
    expect(sent[1]!.headers.get('Idempotency-Key')).toEqual(expect.stringMatching(/\S/));
    expect(sent[1]!.headers.get('Idempotency-Key')).not.toBe(
      sent[0]!.headers.get('Idempotency-Key'),
    );
    expect(server.requests('POST', VERIFY)).toHaveLength(2);
    await settle();
  },
);
