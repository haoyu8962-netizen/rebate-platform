// B1-05ze (FU-DETAIL-GALLERY, CT-26o, D10-649): the images of a product detail card, the same reading
// as the share page (linking shareImages): main image first, then the union's extra images in their
// order; deduplicated before the cut, so a repeat never takes a place; at most 9; addresses unchanged;
// [] when the detail has none. The detail is only read. Rule tests:
// test/spec/catalog/detail-gallery/**.
import type { UnionItemDetail } from '../../union/index.ts';

/** One entry of ProductCard.images (contract ShareImage). */
export interface DetailImage {
  readonly url: string;
}

/** Contract ProductCard.images: at most 9 (same cap as the share page images). */
export const DETAIL_IMAGES_MAX = 9;

export function detailImages(
  item: Pick<UnionItemDetail, 'main_image_url' | 'image_urls'>,
): DetailImage[] {
  const { main_image_url: main, image_urls: gallery = [] } = item;
  const urls = new Set(main === undefined ? gallery : [main, ...gallery]);
  return [...urls].slice(0, DETAIL_IMAGES_MAX).map((url) => ({ url }));
}
