// Generated from specs/creditable-events.yaml by settlement/specs/scripts/generate-creditable-events.ts.
// Do not edit by hand. Regenerate after changing the specification.
export const CREDITABLE_EVENTS = {
  "version": "1",
  "platforms": [
    {
      "platform": "taobao",
      "event": "confirm_receipt"
    },
    {
      "platform": "jd",
      "event": "confirm_receipt"
    },
    {
      "platform": "pdd",
      "event": "confirm_receipt"
    },
    {
      "platform": "meituan",
      "event": "complete_or_verify"
    }
  ]
} as const;
