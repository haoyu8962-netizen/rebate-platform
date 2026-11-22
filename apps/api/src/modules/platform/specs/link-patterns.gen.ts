// Generated from specs/link-patterns.yaml by platform/specs/scripts/generate-link-patterns.ts.
// Do not edit by hand. Regenerate after changing the specification.
export const LINK_PATTERNS = {
  "version": "1",
  "rules": [
    {
      "platform": "taobao",
      "category": "union_host",
      "hosts": [
        "taobao.com",
        "tmall.com",
        "alimama.com"
      ],
      "path_patterns": []
    },
    {
      "platform": "taobao",
      "category": "product",
      "hosts": [
        "item.taobao.com"
      ],
      "path_patterns": [
        "/item.htm"
      ]
    },
    {
      "platform": "taobao",
      "category": "product",
      "hosts": [
        "detail.tmall.com"
      ],
      "path_patterns": [
        "/item.htm"
      ]
    },
    {
      "platform": "taobao",
      "category": "promo",
      "hosts": [
        "s.click.taobao.com"
      ],
      "path_patterns": [
        "/**"
      ]
    },
    {
      "platform": "taobao",
      "category": "promo",
      "hosts": [
        "uland.taobao.com"
      ],
      "path_patterns": [
        "/coupon/**",
        "/quan/**",
        "/item/**"
      ]
    },
    {
      "platform": "jd",
      "category": "union_host",
      "hosts": [
        "jd.com"
      ],
      "path_patterns": []
    },
    {
      "platform": "jd",
      "category": "product",
      "hosts": [
        "item.jd.com"
      ],
      "path_patterns": [
        "/*.html"
      ]
    },
    {
      "platform": "jd",
      "category": "promo",
      "hosts": [
        "union-click.jd.com"
      ],
      "path_patterns": [
        "/jdc"
      ]
    },
    {
      "platform": "pdd",
      "category": "union_host",
      "hosts": [
        "pinduoduo.com",
        "yangkeduo.com"
      ],
      "path_patterns": []
    }
  ]
} as const;
