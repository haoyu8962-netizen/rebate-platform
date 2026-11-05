import { expect, it } from 'vitest';
import { detailImages } from '../../../../apps/api/src/modules/catalog/domain/detail-images.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { MAIN, NINE, ODD, TWELVE, g } from './gallery.ts';

it('[AC-B1-05ze#1] 主图在前、多图按联盟原顺序、截断前去重、地址原样，恰 9 张', () => {
  const gallery = Object.freeze([...TWELVE]);
  const images = detailImages({ main_image_url: MAIN, image_urls: gallery });
  expect(images).toEqual(NINE);
  expect(new Set(images.map((image) => image.url)).size).toBe(images.length);
  // The detail is only read.
  expect(gallery).toEqual(TWELVE);
});

interface Row {
  readonly name: string;
  readonly input: Pick<UnionItemDetail, 'main_image_url' | 'image_urls'>;
  readonly urls: readonly string[];
}

const ROWS: readonly Row[] = [
  { name: '主图缺省只用多图', input: { image_urls: [g(3), ODD, g(1)] }, urls: [g(3), ODD, g(1)] },
  { name: '只有主图', input: { main_image_url: MAIN }, urls: [MAIN] },
  { name: '主图 + 空多图', input: { main_image_url: MAIN, image_urls: [] }, urls: [MAIN] },
  { name: '都没有', input: {}, urls: [] },
  { name: '多图只有主图本身', input: { main_image_url: MAIN, image_urls: [MAIN] }, urls: [MAIN] },
];

it.each(ROWS)('[AC-B1-05ze#2] $name', ({ input, urls }) => {
  expect(detailImages(input)).toEqual(urls.map((url) => ({ url })));
});
