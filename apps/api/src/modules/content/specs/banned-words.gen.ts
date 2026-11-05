// Generated from specs/banned-words.yaml by content/specs/scripts/generate-text-specs.ts.
// Do not edit by hand. Regenerate after changing the specification.
export const BANNED_WORDS = {
  "version": "1",
  "scopes": [
    "user_visible",
    "admin_report"
  ],
  "words": [
    {
      "word": "全网最低",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ]
    },
    {
      "word": "历史最低",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ]
    },
    {
      "word": "最低价",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ]
    },
    {
      "word": "最便宜",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ]
    },
    {
      "word": "最高返利",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ]
    },
    {
      "word": "稳赚",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ]
    },
    {
      "word": "必返",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ]
    },
    {
      "word": "返利最高",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ],
      "note": "待法务确认，确认前启用（BR-PRICE-18）"
    },
    {
      "word": "最高返",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ],
      "note": "待法务确认，确认前启用（BR-PRICE-18）"
    },
    {
      "word": "原价",
      "category": "price_rebate",
      "scopes": [
        "user_visible",
        "admin_report"
      ],
      "note": "待法务确认，确认前启用（BR-PRICE-18）"
    },
    {
      "word": "高佣",
      "category": "ranking",
      "scopes": [
        "user_visible"
      ],
      "note": "榜单类（BR-TEXT-13 细则「榜单类词」，功能对照 Q-27 默认 A，待负责人确认）"
    },
    {
      "word": "收益榜",
      "category": "ranking",
      "scopes": [
        "user_visible"
      ],
      "note": "榜单类（同上）"
    },
    {
      "word": "返利到账",
      "category": "fund",
      "scopes": [
        "user_visible",
        "admin_report"
      ],
      "note": "08 正文的后台与报表豁免逐词列出（佣金、待结算、结算中、返现、充值、备付金），不含本词，所以后台与报表字段同样校验"
    },
    {
      "word": "佣金",
      "category": "fund",
      "scopes": [
        "user_visible"
      ],
      "allow_keys": [
        "agent.disclaimer.commission"
      ],
      "note": "唯一例外是 Agent 佣金披露文案（BR-AI-10，拍板第二批 AI-17），只按原文整体剔除"
    },
    {
      "word": "待结算",
      "category": "fund",
      "scopes": [
        "user_visible"
      ]
    },
    {
      "word": "结算中",
      "category": "fund",
      "scopes": [
        "user_visible"
      ]
    },
    {
      "word": "返现",
      "category": "fund",
      "scopes": [
        "user_visible"
      ]
    },
    {
      "word": "充值",
      "category": "fund",
      "scopes": [
        "user_visible"
      ]
    },
    {
      "word": "备付金",
      "category": "fund",
      "scopes": [
        "user_visible"
      ]
    },
    {
      "word": "比价",
      "category": "field_limited",
      "scopes": [
        "user_visible",
        "admin_report"
      ],
      "allow_keys": [
        "order_reason.PRICE_COMPARE.title",
        "order_reason.PRICE_COMPARE.desc",
        "order_status.PAID.hint.price_compare",
        "no_rebate.price_compare",
        "no_rebate.price_compare.confirm",
        "order.price_compare.hint",
        "order.tag.price_compare"
      ],
      "allow_rendered_in": [
        "ORDER_INVALID",
        "CLAWBACK"
      ],
      "allow_articles": [
        {
          "config_key": "help_links.price_compare",
          "fields": [
            "title",
            "body"
          ]
        }
      ],
      "note": "只允许出现在这些字段；卖点、广告位、分享标题、应用商店描述命中"
    }
  ]
} as const;
