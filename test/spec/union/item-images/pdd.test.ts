import { expect, it } from 'vitest';
import { normalizeItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import { one, row, sources } from '../pdd-goods/kit.ts';
import { IMAGE_FIELDS } from './kit.ts';

// B1-04zzf：按任务确认的字段映射主图和多图；以下地址全为合成值，不是录制。
const host = 'https://img.synthetic.invalid';
const main = `${host}/pdd/main.jpg`;
const gallery = [`${host}/pdd/1.jpg`, `${host}/pdd/2.jpg`, `${host}/pdd/1.jpg`];
const upstreamImages = {
  goods_image_url: main,
  goods_thumbnail_url: `${host}/pdd/thumb.jpg`,
  goods_gallery_urls: gallery,
  // 与统一 DTO 同名的字段同样不得透传。
  main_image_url: main,
  image_urls: gallery,
};

it.each(sources)(
  '[AC-B1-22s-PDD#1] %s 上游主图和多图清洗后映射到 DTO，同名字段不透传',
  async (source) => {
    expect(normalizeItemImages({ main_image_url: main, image_urls: gallery })).toEqual({
      main_image_url: main,
      image_urls: [`${host}/pdd/1.jpg`, `${host}/pdd/2.jpg`],
    });
    const plain = await one(source, row());
    const withImages = await one(source, row(upstreamImages));
    expect(withImages).toEqual({
      ...plain,
      main_image_url: main,
      image_urls: [`${host}/pdd/1.jpg`, `${host}/pdd/2.jpg`],
    });
    for (const field of Object.keys(upstreamImages).filter(
      (key) => !IMAGE_FIELDS.some((imageField) => imageField === key),
    )) {
      expect(Object.hasOwn(withImages, field), field).toBe(false);
    }
    expect(Object.values(withImages)).toContain(main);
    const spoofed = await one(
      source,
      row({
        ...upstreamImages,
        main_image_url: `${host}/pdd/spoof-main.jpg`,
        image_urls: [`${host}/pdd/spoof-gallery.jpg`],
      }),
    );
    expect(spoofed).toEqual(withImages);
  },
);
