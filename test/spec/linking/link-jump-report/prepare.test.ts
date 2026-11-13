import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { prepareEvents } from '../../../../apps/api/src/modules/linking/application/ingest-events.ts';
import {
  CLIENT_AT,
  INVALID_ITEMS,
  allEvents,
  common,
  jump,
  spec,
  without,
  type Event,
} from './vectors.ts';

const context = { appId: 'synthetic-app', userId: randomUUID(), deviceId: randomUUID() };

it('[AC-B1-06zo#1] 接线形状只信服务端身份，props 不含运输字段或客户端身份，不修改原事件', () => {
  const event = { ...jump(), user_id: randomUUID(), device_id: 'forged-body-device' };
  const before = structuredClone(event);
  const prepared = prepareEvents(context, [event]);
  const props = Object.fromEntries(
    Object.entries(event).filter(
      ([key]) => !['event_id', 'name', 'client_at', 'user_id', 'device_id'].includes(key),
    ),
  );
  expect(prepared).toEqual({
    droppedCount: 0,
    batch: {
      ...context,
      events: [{ eventId: event.event_id, eventType: 'link_jump', clientAt: CLIENT_AT, props }],
    },
  });
  expect(event).toEqual(before);
  expect(prepareEvents({ ...context, userId: null, deviceId: null }, [event]).batch).toMatchObject({
    userId: null,
    deviceId: null,
  });
});

it('[AC-B1-06zo#2] specs/events.yaml 全部已登记事件都受理，非 link_jump 也保留给未来接线点', () => {
  const events = allEvents();
  const result = prepareEvents(context, events);
  expect(result.droppedCount).toBe(0);
  expect(result.batch.events.map((event) => event.eventType)).toEqual(Object.keys(spec.events));
  expect(result.batch.events.map((event) => event.eventId)).toEqual(
    events.map((e) => e['event_id']),
  );
  expect(prepareEvents(context, [])).toEqual({
    droppedCount: 0,
    batch: { ...context, events: [] },
  });
});

it('[AC-B1-06zo#3] 坏条目逐条丢弃，合法的前后两条不受牵连，丢弃数准确', () => {
  const first = jump();
  const last = common();
  const result = prepareEvents(context, [first, ...INVALID_ITEMS, last]);
  expect(result.droppedCount).toBe(INVALID_ITEMS.length);
  expect(result.batch.events.map((event) => event.eventId)).toEqual([
    first['event_id'],
    last['event_id'],
  ]);
  const allBad = prepareEvents(context, INVALID_ITEMS);
  expect(allBad).toEqual({ droppedCount: INVALID_ITEMS.length, batch: { ...context, events: [] } });
});

for (const event of allEvents()) {
  const name = String(event['name']);
  const fields = { ...spec.common_fields, ...spec.events[name]!.fields };
  it(`[AC-B1-06zo#4] ${name} 的公共及事件字段按规格校验必填、类型和枚举，不做类型强转`, () => {
    const invalid: unknown[] = [];
    for (const [key, field] of Object.entries(fields)) {
      if (field.required) invalid.push(without(event, key));
      // Give every optional field a wrong primitive too, rather than silently ignoring it.
      invalid.push({
        ...event,
        [key]: field.type === 'integer' ? '1' : field.type === 'boolean' ? 'true' : 9,
      });
      if (field.type === 'enum') invalid.push({ ...event, [key]: 'not-in-enum' });
    }
    const result = prepareEvents(context, [...invalid, event]);
    expect(result.droppedCount).toBe(invalid.length);
    expect(result.batch.events).toHaveLength(1);
    expect(result.batch.events[0]?.eventId).toBe(event['event_id']);
  });
}

it('[AC-B1-06zo#5] 购买条件字段必带，但 BR-ATTR-21 明许缺 attempt_id 只当埋点；startup 无尝试也合规', () => {
  const startup = {
    ...common('link_jump'),
    phase: 'startup',
    union_platform: 'taobao',
    step: 'sdk',
    result: 'failed',
    failure_reason: 'sdk_init_failed',
    sdk_open_by: 'url',
    sdk_error_code: 'synthetic',
  };
  const valid: Event[] = [
    without(jump(), 'attempt_id'),
    jump({ attempt_id: 'not-a-uuid' }),
    startup,
  ];
  const invalid = ['link_id', 'duration_ms', 'installed'].map((key) => without(jump(), key));
  const result = prepareEvents(context, [...invalid, ...valid]);
  expect(result.droppedCount).toBe(invalid.length);
  expect(result.batch.events.map((event) => event.eventId)).toEqual(
    valid.map((e) => e['event_id']),
  );
});

it('[AC-B1-06zo#6] 三种结果与 SDK 两种 open_by 可受理，失败原因必填；复制口令 requested 也是有效事件', () => {
  const events = ['requested', 'unknown', 'failed'].flatMap((result) =>
    ['url', 'code'].map((sdk_open_by) =>
      jump({
        union_platform: 'taobao',
        step: 'sdk',
        sdk_open_by,
        result,
        ...(result === 'failed'
          ? { failure_reason: 'step_failed', sdk_error_code: 'synthetic' }
          : {}),
      }),
    ),
  );
  events.push(jump({ union_platform: 'taobao', step: 'copy_tpwd' }));
  const result = prepareEvents(context, events);
  expect(result.droppedCount).toBe(0);
  expect(result.batch.events).toHaveLength(events.length);
});

it('[AC-B1-06zo#7] 同批相同 name/event_id 不重复整理且不计丢弃，不同 name 可共用 event_id', () => {
  const event = jump();
  const other = { ...common(), event_id: event['event_id'] };
  const result = prepareEvents(context, [event, { ...event }, other, { ...other }]);
  expect(result.droppedCount).toBe(0);
  expect(result.batch.events.map((e) => [e.eventType, e.eventId])).toEqual([
    ['link_jump', event['event_id']],
    ['page_view', event['event_id']],
  ]);
});
