import { expect, it } from 'vitest';
import {
  ctx,
  DETAIL,
  detailRow,
  detailSetup,
  formOf,
  ITEM_ID,
  ref,
  type Row,
  sent,
  visible,
} from '../taobao-goods/kit.ts';

// Task-local AC label ([AC-B1-04zzzw#1]) identifies this task's acceptance point, not a business rule.
// 依据：D10-953 / D10-961，2026-11-08 详情实录（taobao.tbk.item.info.upgrade.get，凑狸应用）——
// item_basic_info 只有 level_one_category_name 与 category_name 两个类目名称，没有任何类目 ID 字段。
// 合成、非录制：只按实录的字段名与嵌套构造，取值全部合成；只读复用 ../taobao-goods/kit.ts，不改冻结文件。

const L1_NAME = '合成实录一级类目';
const LEAF_NAME = '合成实录叶子类目';

/**
 * A detail row in the recorded shape: the kit's default row with level_one_category_id removed as
 * a key (kit.detailRow can only override with an undefined value, so the key is deleted from a
 * copy here instead), level_one_category_name kept, and a leaf category_name added.
 */
function recordedRow(): Row {
  const row = detailRow();
  const basic: Row = { ...(row['item_basic_info'] as Row) };
  delete basic['level_one_category_id'];
  basic['level_one_category_name'] = L1_NAME;
  basic['category_name'] = LEAF_NAME;
  return { ...row, item_basic_info: basic };
}

it('[AC-B1-04zzzw#1] 详情按实录形状（无一级类目 ID、有一级名与叶子名）：不出 category_l1_id，category_l1_name 取一级名，叶子名不进任何字段', async () => {
  const row = recordedRow();
  const basic = row['item_basic_info'] as Row;
  expect(Object.keys(basic)).not.toContain('level_one_category_id');
  expect(Object.keys(basic)).toEqual(
    expect.arrayContaining(['level_one_category_name', 'category_name']),
  );

  const { adapter, transport } = detailSetup([row]);
  const detail = await adapter.getItem(ref, ctx);

  expect(formOf(sent(transport))['method']).toBe(DETAIL);
  expect(detail).toMatchObject({ platform: 'taobao', item_id: ITEM_ID });
  expect(detail).not.toHaveProperty('category_l1_id');
  expect(detail.category_l1_name).toBe(L1_NAME);
  expect(Object.values(detail)).not.toContain(LEAF_NAME);
  expect(visible(detail)).not.toContain(LEAF_NAME);
});
