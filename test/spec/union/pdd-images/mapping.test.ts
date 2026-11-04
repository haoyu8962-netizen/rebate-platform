import { expect, it } from 'vitest';
import { normalizeItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import { imagesOf } from '../item-images/kit.ts';
import { one, row } from '../pdd-goods/kit.ts';

// 字段形状来自任务书；值全为合成值。清洗口径只以 normalizeItemImages 为准。
const sources = ['search', 'detail'] as const;
const host = 'https://img.synthetic.invalid';
const main = `${host}/main.jpg?size=large&v=1`;
const other = `${host}/gallery.jpg`;
const thumbnail = `${host}/thumbnail.jpg`;
const spoof = `${host}/dto-spoof.jpg`;

it.each(sources)(
  '[AC-B1-04zzf#1] %s 主图和多图取平台字段并清洗，DTO 同名字段不透传',
  async (source) => {
    const gallery = [other, '', null, other, main, 'http://img.synthetic.invalid/bad.jpg'];
    const actual = await one(
      source,
      row({
        goods_image_url: main,
        goods_gallery_urls: gallery,
        goods_thumbnail_url: thumbnail,
        main_image_url: spoof,
        image_urls: [spoof],
      }),
    );
    expect(imagesOf(actual)).toEqual(
      normalizeItemImages({ main_image_url: main, image_urls: gallery }),
    );
    expect(imagesOf(actual)).toEqual({ main_image_url: main, image_urls: [other, main] });
    for (const field of ['goods_image_url', 'goods_gallery_urls', 'goods_thumbnail_url']) {
      expect(Object.hasOwn(actual, field), field).toBe(false);
    }
  },
);

it.each(sources)(
  '[AC-B1-04zzf#2] %s 主图缺失或不合格不从多图、缩略图、DTO 同名字段补',
  async (source) => {
    const mains: readonly unknown[] = [
      main,
      undefined,
      null,
      '',
      'http://img.synthetic.invalid/main.jpg',
      '//img.synthetic.invalid/main.jpg',
      'https:///no-host.jpg',
      `${host}/has space.jpg`,
      `${host}/control\u007f.jpg`,
      `${host}/${'x'.repeat(2048)}`,
      123,
    ];
    const actual = [];
    for (const value of mains) {
      const dto = await one(
        source,
        row({
          ...(value === undefined ? {} : { goods_image_url: value }),
          goods_gallery_urls: [other],
          goods_thumbnail_url: thumbnail,
          main_image_url: spoof,
          image_urls: [spoof],
        }),
      );
      actual.push(imagesOf(dto));
    }
    expect(actual).toEqual(
      mains.map((value) => normalizeItemImages({ main_image_url: value, image_urls: [other] })),
    );
  },
);

it.each(sources)(
  '[AC-B1-04zzf#3] %s 未给 gallery 或多图全无效时字段缺省，不把主图塞进多图',
  async (source) => {
    const galleries: readonly unknown[] = [
      undefined,
      null,
      [],
      [null, '', 'http://img.synthetic.invalid/bad.jpg', 42],
      other,
      { url: other },
    ];
    const actual = [];
    for (const gallery of galleries) {
      const dto = await one(
        source,
        row({
          goods_image_url: main,
          ...(gallery === undefined ? {} : { goods_gallery_urls: gallery }),
          goods_thumbnail_url: thumbnail,
          image_urls: [spoof],
        }),
      );
      actual.push(imagesOf(dto));
    }
    expect(actual).toEqual(galleries.map(() => ({ main_image_url: main })));
  },
);

it.each(sources)(
  '[AC-B1-04zzf#4] %s 多图清洗保持顺序与现有上限，只有缩略图或同名字段仍无图',
  async (source) => {
    const gallery = [
      null,
      ...Array.from({ length: 12 }, (_unused, index) => `${host}/gallery-${index}.jpg`),
    ];
    gallery.splice(3, 0, gallery[1]!);
    const mapped = await one(source, row({ goods_image_url: main, goods_gallery_urls: gallery }));
    const spoofed = await one(
      source,
      row({ goods_thumbnail_url: thumbnail, main_image_url: spoof, image_urls: [spoof] }),
    );
    const empty = await one(source, row());
    expect([imagesOf(mapped), imagesOf(spoofed), imagesOf(empty)]).toEqual([
      normalizeItemImages({ main_image_url: main, image_urls: gallery }),
      {},
      {},
    ]);
  },
);
