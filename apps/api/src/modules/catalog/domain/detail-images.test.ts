import { expect, it } from 'vitest';
import { DETAIL_IMAGES_MAX, detailImages } from './detail-images.ts';

const MAIN = 'https://img.example.test/unit/main.jpg';

function g(n: number): string {
  return `https://img.example.test/unit/g${n}.jpg`;
}

it('[AC-B1-05ze] 主图在前，多图按原顺序', () => {
  expect(detailImages({ main_image_url: MAIN, image_urls: [g(2), g(1)] })).toEqual([
    { url: MAIN },
    { url: g(2) },
    { url: g(1) },
  ]);
});

it('[AC-B1-05ze] 去重保留首次出现，重复不占位，截断在去重之后', () => {
  const gallery = [g(1), g(1), MAIN, g(2), g(3), g(4), g(5), g(6), g(7), g(8), g(9)];
  const images = detailImages({ main_image_url: MAIN, image_urls: gallery });
  expect(images).toHaveLength(DETAIL_IMAGES_MAX);
  expect(images.map((image) => image.url)).toEqual([
    MAIN,
    g(1),
    g(2),
    g(3),
    g(4),
    g(5),
    g(6),
    g(7),
    g(8),
  ]);
});

it('[AC-B1-05ze] 不足 9 张时原样全部返回，地址逐字不变', () => {
  const odd = 'https://img.example.test/unit/A%20b.PNG?x=1&y=2';
  expect(detailImages({ image_urls: [odd] })).toEqual([{ url: odd }]);
});

it('[AC-B1-05ze] 主图与多图都没有时为 []；每次返回新数组', () => {
  const first = detailImages({});
  expect(first).toEqual([]);
  expect(detailImages({})).not.toBe(first);
});

it('[AC-B1-05ze] 只读入参：不改调用方的多图数组', () => {
  const gallery = [g(1), g(1), g(2)];
  detailImages({ main_image_url: MAIN, image_urls: gallery });
  expect(gallery).toEqual([g(1), g(1), g(2)]);
});
