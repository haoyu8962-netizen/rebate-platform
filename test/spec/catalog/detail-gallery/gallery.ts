// Synthetic image addresses for the B1-05ze rule tests (no real host).
export const MAIN = 'https://img.example.test/p/main.jpg';

export function g(n: number): string {
  return `https://img.example.test/p/g${n}.jpg`;
}

/** An address that must come back character for character (case, query, encoding). */
export const ODD = 'https://img.example.test/p/Odd%20Name.JPG?size=800x800&v=2';

/**
 * 12 union extra images: two repeats (g(1), g(2)) and one equal to the main image. Deduplicated
 * before the cut with the main image first there are 10 distinct addresses, so exactly 9 remain.
 */
export const TWELVE: readonly string[] = [
  g(1),
  g(2),
  MAIN,
  ODD,
  g(1),
  g(4),
  g(5),
  g(2),
  g(6),
  g(7),
  g(8),
  g(9),
];

/** The expected images of MAIN + TWELVE. */
export const NINE: readonly { url: string }[] = [
  { url: MAIN },
  { url: g(1) },
  { url: g(2) },
  { url: ODD },
  { url: g(4) },
  { url: g(5) },
  { url: g(6) },
  { url: g(7) },
  { url: g(8) },
];
