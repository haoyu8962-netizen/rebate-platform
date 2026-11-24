// B1-04zzzzm: unit tests of the publisher answer readers (synthetic bodies only).
import { expect, it } from 'vitest';
import { queriedRelationId, savedRelationId, saveRefusalIsDefinite } from './publisher.ts';

const getBody = (rows: string) =>
  `{"tbk_sc_publisher_info_get_response":{"data":{"inviter_list":{"map_data":[${rows}]}}}}`;

it('[AC-B1-04zzzzm#3] save 编号按原文取，非数字文本不当编号', () => {
  const save = (id: string) =>
    `{"tbk_sc_publisher_info_save_response":{"data":{"relation_id":${id}}}}`;
  expect(savedRelationId(save('12345678901234567890'))).toBe('12345678901234567890');
  expect(savedRelationId(save('"0042"'))).toBe('0042');
  expect(savedRelationId(save('"abc"'))).toBeNull();
  expect(savedRelationId(save('-1'))).toBeNull();
  expect(savedRelationId('not json')).toBeNull();
});

it('[AC-B1-04zzzzm#4] get 只认 common 场景的唯一编号，多个不同编号不猜', () => {
  expect(
    queriedRelationId(getBody('{"relation_app":"etao","relation_id":1},{"relation_id":2}')),
  ).toEqual({ kind: 'found', relationId: '2' });
  expect(
    queriedRelationId(
      getBody(
        '{"relation_app":"common","relation_id":3},{"relation_app":"common","relation_id":3}',
      ),
    ),
  ).toEqual({ kind: 'found', relationId: '3' });
  expect(
    queriedRelationId(
      getBody(
        '{"relation_app":"common","relation_id":3},{"relation_app":"common","relation_id":4}',
      ),
    ),
  ).toEqual({ kind: 'ambiguous' });
  expect(queriedRelationId(getBody(''))).toEqual({ kind: 'none' });
});

it('[AC-B1-04zzzzn#7] save 的业务拒绝算明确结局，网关系统错与非应答算未知', () => {
  const refusal = (fields: string) => `{"error_response":{"code":15${fields}}}`;
  expect(saveRefusalIsDefinite(200, refusal(''))).toBe(true);
  expect(saveRefusalIsDefinite(200, refusal(',"sub_code":"isv.invalid-parameter"'))).toBe(true);
  expect(saveRefusalIsDefinite(200, refusal(',"sub_code":"isp.call-limited"'))).toBe(true);
  expect(saveRefusalIsDefinite(200, refusal(',"sub_code":"isp.remote-service-timeout"'))).toBe(
    false,
  );
  expect(saveRefusalIsDefinite(502, refusal(''))).toBe(false);
  expect(saveRefusalIsDefinite(200, 'not json')).toBe(false);
  expect(saveRefusalIsDefinite(200, '{"tbk_sc_publisher_info_save_response":{}}')).toBe(false);
});
