// Generated from contracts/openapi.yaml by platform/validation/scripts/generate-route-schemas.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_ROUTE_SCHEMAS = {
  "getHealthz": {},
  "registerDevice": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "device_hash",
        "id_source"
      ],
      "properties": {
        "device_hash": {
          "type": "string",
          "description": "lowercase_hex(SHA-256(UTF-8 bytes of the identifier, trimmed and lower-cased)) of IDFV\n(iOS), ANDROID_ID (Android, MVP) or ODID (Harmony) (BR-ID-09 细则「设备标识的无效值」).\n",
          "pattern": "^[0-9a-f]{64}$"
        },
        "id_source": {
          "type": "string",
          "description": "Which device identifier was hashed (enum device_id_source, BR-ID-09).",
          "enum": [
            "idfv",
            "android_id",
            "oaid",
            "odid"
          ]
        }
      }
    }
  },
  "reportPushToken": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "provider",
        "token"
      ],
      "properties": {
        "provider": {
          "type": "string",
          "description": "Push provider; a string until the provider is chosen (D-14).",
          "minLength": 1,
          "maxLength": 32
        },
        "token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        }
      }
    }
  },
  "sendSmsCode": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "purpose"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "purpose": {
          "type": "string",
          "description": "contracts/enums/identity.yaml sms_purpose.",
          "enum": [
            "login",
            "bind",
            "step_up"
          ]
        },
        "captcha_token": {
          "type": "string",
          "description": "Human-verification token, required after 44003 (BR-ID-05).",
          "maxLength": 2048
        },
        "action": {
          "description": "With purpose=step_up the client always sends the action the code is for; the version\ngate and the session scope are decided from it (BR-ID-01 细则): only\naction=account_deletion is exempt, and a step_up request without action is gated.\npurpose=login is exempt regardless of action; purpose=bind is gated.\n",
          "type": "string",
          "enum": [
            "withdraw",
            "payout_account_change",
            "phone_change",
            "account_deletion"
          ]
        }
      }
    }
  },
  "loginBySms": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "code",
        "legal_versions",
        "consent_at"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "code": {
          "type": "string",
          "pattern": "^[0-9]{6}$"
        },
        "legal_versions": {
          "type": "object",
          "description": "Versions of the privacy policy and user agreement the user agreed to (BR-ID-04).",
          "additionalProperties": false,
          "required": [
            "privacy",
            "agreement"
          ],
          "properties": {
            "privacy": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            },
            "agreement": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            }
          }
        },
        "consent_at": {
          "type": "string",
          "format": "date-time",
          "description": "When the box was ticked or the confirm dialog accepted (client clock)."
        },
        "invite_code": {
          "type": "string",
          "description": "Optional invite code; ignored for an existing account (BR-INV-06).",
          "maxLength": 32
        }
      }
    }
  },
  "createOauthAttempt": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "description": "`action` is required exactly for purpose=step_up. purpose=payout_bind is for WeChat only\nand carries no `action`. purpose=reverify (re-verification of a recycled phone, BR-WDR-01\n细则) carries no `action`. The oneOf branches declare the properties they constrain (strict\nAjv2020, ADR-0001 §4.2 #15).\n",
      "additionalProperties": false,
      "required": [
        "provider",
        "purpose"
      ],
      "properties": {
        "provider": {
          "type": "string",
          "description": "Third-party identity provider (enum login_provider, BR-ID-04).",
          "enum": [
            "wechat",
            "apple",
            "huawei"
          ]
        },
        "purpose": {
          "type": "string",
          "description": "What a third-party authorization attempt is for (enum oauth_attempt_purpose).",
          "enum": [
            "login",
            "step_up",
            "payout_bind",
            "reverify"
          ]
        },
        "action": {
          "type": "string",
          "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
          "enum": [
            "withdraw",
            "payout_account_change",
            "phone_change",
            "account_deletion"
          ]
        }
      },
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "purpose": {
              "type": "string",
              "enum": [
                "login"
              ]
            }
          },
          "required": [
            "purpose"
          ]
        },
        {
          "type": "object",
          "properties": {
            "purpose": {
              "type": "string",
              "enum": [
                "step_up"
              ]
            },
            "action": {
              "type": "string",
              "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
              "enum": [
                "withdraw",
                "payout_account_change",
                "phone_change",
                "account_deletion"
              ]
            }
          },
          "required": [
            "purpose",
            "action"
          ]
        },
        {
          "type": "object",
          "properties": {
            "purpose": {
              "type": "string",
              "enum": [
                "payout_bind"
              ]
            },
            "provider": {
              "type": "string",
              "enum": [
                "wechat"
              ]
            }
          },
          "required": [
            "purpose",
            "provider"
          ],
          "not": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
              "action": {
                "type": "string",
                "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
                "enum": [
                  "withdraw",
                  "payout_account_change",
                  "phone_change",
                  "account_deletion"
                ]
              }
            },
            "required": [
              "action"
            ]
          }
        },
        {
          "type": "object",
          "properties": {
            "purpose": {
              "type": "string",
              "enum": [
                "reverify"
              ]
            }
          },
          "required": [
            "purpose"
          ],
          "not": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
              "action": {
                "type": "string",
                "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
                "enum": [
                  "withdraw",
                  "payout_account_change",
                  "phone_change",
                  "account_deletion"
                ]
              }
            },
            "required": [
              "action"
            ]
          }
        }
      ]
    }
  },
  "loginByWechat": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "attempt_id",
        "code",
        "legal_versions",
        "consent_at"
      ],
      "properties": {
        "attempt_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "code": {
          "type": "string",
          "description": "An authorization credential from the provider SDK; never stored or logged.",
          "minLength": 1,
          "maxLength": 4096
        },
        "legal_versions": {
          "type": "object",
          "description": "Versions of the privacy policy and user agreement the user agreed to (BR-ID-04).",
          "additionalProperties": false,
          "required": [
            "privacy",
            "agreement"
          ],
          "properties": {
            "privacy": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            },
            "agreement": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            }
          }
        },
        "consent_at": {
          "type": "string",
          "format": "date-time"
        }
      }
    }
  },
  "loginByApple": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "attempt_id",
        "identity_token",
        "authorization_code",
        "legal_versions",
        "consent_at"
      ],
      "properties": {
        "attempt_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "identity_token": {
          "type": "string",
          "description": "An authorization credential from the provider SDK; never stored or logged.",
          "minLength": 1,
          "maxLength": 4096
        },
        "authorization_code": {
          "type": "string",
          "description": "An authorization credential from the provider SDK; never stored or logged.",
          "minLength": 1,
          "maxLength": 4096
        },
        "legal_versions": {
          "type": "object",
          "description": "Versions of the privacy policy and user agreement the user agreed to (BR-ID-04).",
          "additionalProperties": false,
          "required": [
            "privacy",
            "agreement"
          ],
          "properties": {
            "privacy": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            },
            "agreement": {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            }
          }
        },
        "consent_at": {
          "type": "string",
          "format": "date-time"
        }
      }
    }
  },
  "stepUp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "description": "Exactly one way of second verification: an SMS code, or a new authorization with one\nprovider carrying that provider's login credential fields (BR-ID-08). Each branch is a\nclosed object, so a body mixing two ways matches none.\n",
      "unevaluatedProperties": false,
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "code"
          ],
          "properties": {
            "action": {
              "type": "string",
              "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
              "enum": [
                "withdraw",
                "payout_account_change",
                "phone_change",
                "account_deletion"
              ]
            },
            "code": {
              "type": "string",
              "pattern": "^[0-9]{6}$"
            },
            "summary": {
              "description": "The business summary bound into a withdraw or payout_account_change step-up token\n(BR-ID-08 细则「绑定业务摘要」): a withdrawal (payout_account_id of GET\n/v1/me/payout-account and amount_fen), or the new payout account to be saved. Which shape\ngoes with which action is checked by the server (20001 data.fields=[summary]). No payee\nname and no client-computed fingerprint.\n",
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_account_id",
                    "amount_fen"
                  ],
                  "properties": {
                    "payout_account_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    },
                    "amount_fen": {
                      "type": "integer",
                      "format": "int64",
                      "minimum": 1
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "alipay_logon_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "alipay"
                      ]
                    },
                    "alipay_logon_id": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "card_no"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "bank_card"
                      ]
                    },
                    "card_no": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 32
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "attempt_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "wechat"
                      ]
                    },
                    "attempt_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    }
                  }
                }
              ]
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "provider",
            "attempt_id",
            "code"
          ],
          "properties": {
            "action": {
              "type": "string",
              "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
              "enum": [
                "withdraw",
                "payout_account_change",
                "phone_change",
                "account_deletion"
              ]
            },
            "provider": {
              "type": "string",
              "enum": [
                "wechat"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            },
            "summary": {
              "description": "The business summary bound into a withdraw or payout_account_change step-up token\n(BR-ID-08 细则「绑定业务摘要」): a withdrawal (payout_account_id of GET\n/v1/me/payout-account and amount_fen), or the new payout account to be saved. Which shape\ngoes with which action is checked by the server (20001 data.fields=[summary]). No payee\nname and no client-computed fingerprint.\n",
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_account_id",
                    "amount_fen"
                  ],
                  "properties": {
                    "payout_account_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    },
                    "amount_fen": {
                      "type": "integer",
                      "format": "int64",
                      "minimum": 1
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "alipay_logon_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "alipay"
                      ]
                    },
                    "alipay_logon_id": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "card_no"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "bank_card"
                      ]
                    },
                    "card_no": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 32
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "attempt_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "wechat"
                      ]
                    },
                    "attempt_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    }
                  }
                }
              ]
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "provider",
            "attempt_id",
            "identity_token",
            "authorization_code"
          ],
          "properties": {
            "action": {
              "type": "string",
              "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
              "enum": [
                "withdraw",
                "payout_account_change",
                "phone_change",
                "account_deletion"
              ]
            },
            "provider": {
              "type": "string",
              "enum": [
                "apple"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "identity_token": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            },
            "authorization_code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            },
            "summary": {
              "description": "The business summary bound into a withdraw or payout_account_change step-up token\n(BR-ID-08 细则「绑定业务摘要」): a withdrawal (payout_account_id of GET\n/v1/me/payout-account and amount_fen), or the new payout account to be saved. Which shape\ngoes with which action is checked by the server (20001 data.fields=[summary]). No payee\nname and no client-computed fingerprint.\n",
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_account_id",
                    "amount_fen"
                  ],
                  "properties": {
                    "payout_account_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    },
                    "amount_fen": {
                      "type": "integer",
                      "format": "int64",
                      "minimum": 1
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "alipay_logon_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "alipay"
                      ]
                    },
                    "alipay_logon_id": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "card_no"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "bank_card"
                      ]
                    },
                    "card_no": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 32
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "attempt_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "wechat"
                      ]
                    },
                    "attempt_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    }
                  }
                }
              ]
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "action",
            "provider",
            "attempt_id",
            "authorization_code"
          ],
          "properties": {
            "action": {
              "type": "string",
              "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
              "enum": [
                "withdraw",
                "payout_account_change",
                "phone_change",
                "account_deletion"
              ]
            },
            "provider": {
              "type": "string",
              "enum": [
                "huawei"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "authorization_code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            },
            "summary": {
              "description": "The business summary bound into a withdraw or payout_account_change step-up token\n(BR-ID-08 细则「绑定业务摘要」): a withdrawal (payout_account_id of GET\n/v1/me/payout-account and amount_fen), or the new payout account to be saved. Which shape\ngoes with which action is checked by the server (20001 data.fields=[summary]). No payee\nname and no client-computed fingerprint.\n",
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_account_id",
                    "amount_fen"
                  ],
                  "properties": {
                    "payout_account_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    },
                    "amount_fen": {
                      "type": "integer",
                      "format": "int64",
                      "minimum": 1
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "alipay_logon_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "alipay"
                      ]
                    },
                    "alipay_logon_id": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "card_no"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "bank_card"
                      ]
                    },
                    "card_no": {
                      "type": "string",
                      "description": "As it will be sent to PUT /v1/me/payout-account; normalised by the server.",
                      "minLength": 1,
                      "maxLength": 32
                    }
                  }
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "payout_method",
                    "attempt_id"
                  ],
                  "properties": {
                    "payout_method": {
                      "type": "string",
                      "enum": [
                        "wechat"
                      ]
                    },
                    "attempt_id": {
                      "type": "string",
                      "description": "Entity id, a UUIDv7 string (04 §5).",
                      "minLength": 1,
                      "maxLength": 64
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    }
  },
  "refreshToken": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "refresh_token"
      ],
      "properties": {
        "refresh_token": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  "logout": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "recordConsent": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type",
        "version",
        "accepted",
        "channel",
        "client_at"
      ],
      "properties": {
        "type": {
          "type": "string",
          "description": "consent_type without labor_agreement (BR-ID-12, BR-WDR-31).",
          "enum": [
            "privacy",
            "agreement",
            "ai_third_party",
            "id_verification",
            "personalization",
            "clipboard_auto_import"
          ]
        },
        "version": {
          "description": "The version of the text the user saw. A positive integer (legal.privacy.version and the\nlike) for every type except clipboard_auto_import, which takes the string\nconfig.clipboard.consent_version (BR-ID-12 细则, BR-ID-16). A form that does not pair\nwith `type` → 20001 with data.fields=[version].\n",
          "oneOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 1
            },
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 32
            }
          ]
        },
        "accepted": {
          "type": "boolean",
          "description": "true = agreed; false = withdrawn."
        },
        "channel": {
          "type": "string",
          "description": "consent_channel without the server-written login_merge, h5_landing and withdraw_flow.",
          "enum": [
            "first_launch",
            "login_page",
            "agent_sheet",
            "realname_sheet",
            "privacy_center"
          ]
        },
        "client_at": {
          "type": "string",
          "format": "date-time",
          "description": "When the user tapped (device clock)."
        }
      }
    }
  },
  "issueH5Token": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "scope": {
          "description": "Filled by the native app from its force-update state; H5 cannot choose it. The value\nused when it is absent is set in BR-ID-32 细则「只读作用域」.\n",
          "type": "string",
          "enum": [
            "standard",
            "read_only"
          ]
        }
      }
    }
  },
  "listUnionBindings": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "getUnionAuthUrl": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [
        "platform"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "installed": {
          "type": "string",
          "description": "Whether the platform app is installed, as detected by the client (BR-ATTR-27 ①); the\nstrings \"true\" / \"false\" / \"unknown\" (enum installed_state).\n",
          "enum": [
            "true",
            "false",
            "unknown"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "bindUnion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [
        "platform"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Exactly one authorization method (BR-ID-17 细则「授权方式」); each branch is closed, so\nundefined fields are 20001.\n",
      "unevaluatedProperties": false,
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "state",
            "auth_method",
            "code"
          ],
          "properties": {
            "state": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "auth_method": {
              "type": "string",
              "enum": [
                "web_code"
              ]
            },
            "code": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "state",
            "auth_method",
            "access_token",
            "expires_in"
          ],
          "properties": {
            "state": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "auth_method": {
              "type": "string",
              "enum": [
                "sdk_token"
              ]
            },
            "access_token": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "expires_in": {
              "type": "integer",
              "format": "int64",
              "minimum": 1,
              "description": "Lifetime of the access token in seconds, as the SDK returned it."
            }
          }
        }
      ]
    }
  },
  "listOrders": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "scope": {
          "type": "string",
          "enum": [
            "self",
            "share"
          ]
        },
        "status_group": {
          "type": "string",
          "description": "Status group of the order list (enum order_status_group; members in BR-TEXT-02 细则).",
          "enum": [
            "all",
            "estimating",
            "credited",
            "no_rebate"
          ]
        },
        "display_status": {
          "type": "string",
          "description": "User-visible order status (enum display_status; BR-FUND-17); unknown codes map to UNKNOWN.",
          "enum": [
            "PAID",
            "DEPOSIT_PAID",
            "WAITING",
            "CREDITING",
            "REVIEWING",
            "RIGHTS_PENDING",
            "CREDITED",
            "CREDITED_PART_CLAWED",
            "NO_REBATE",
            "INVALID",
            "CLAWED_BACK"
          ]
        },
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "paid_month": {
          "type": "string",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
        },
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [
        "scope"
      ],
      "additionalProperties": false
    }
  },
  "listOrderClaims": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "createOrderClaim": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "platform",
        "order_no",
        "paid_date"
      ],
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "order_no": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "Order number; spaces are removed, then it is matched exactly as a string, first against child order numbers, then against parent order numbers (BR-ATTR-17). For pdd the hyphens are removed from both the input and the stored numbers before comparing; stored and displayed numbers are unchanged. Empty after removing spaces is 20001."
        },
        "paid_date": {
          "type": "string",
          "format": "date",
          "description": "Payment date, YYYY-MM-DD in +08:00 (second factor); for a pre-sale order the date the deposit was paid."
        }
      }
    }
  },
  "listPendingTracks": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "dismissPendingTrack": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "link_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "link_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "attempt_id"
      ],
      "properties": {
        "attempt_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "getOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "order_id"
      ],
      "additionalProperties": false
    }
  },
  "getAgreements": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    }
  },
  "getAgreementVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type; 01 §4.2). sdk_list (the SDK list) and collect_list\n(the personal information collection list) are versioned public notices only: published\nlike the others (BR-ID-12) but taking no part in consent (D10-465) — min_version always\nequals version, never in first-launch consent, re-consent or re-signing, and never listed\nby GET /v1/agreements. Consent and signing fields keep their own types without these two.\n",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement",
            "sdk_list",
            "collect_list"
          ]
        }
      },
      "required": [
        "type"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "listArticles": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "category": {
          "type": "string",
          "description": "Article category (04 §6.2：帮助、规则、公告、协议; codes defined here, no enums/ entry yet).",
          "enum": [
            "help",
            "rule",
            "notice",
            "agreement"
          ]
        },
        "help_section": {
          "type": "string",
          "description": "Sub-section of a help article (04 §3.2 articles.help_section; 变更记录 20261020-内容线默认回写\n§1.6). Codes are defined by the contract line (no enums/ entry, same as ArticleCategory);\nthe list follows the help-centre board and grows or shrinks with it under the enum\nextension rules: getting_started = 新手教程, rebate_settlement = 返利与结算, orders_claims =\n订单与找回, withdraw = 提现, invite = 邀请好友, account_privacy = 账号与隐私. Only an article of\ncategory help may carry one.\n",
          "enum": [
            "getting_started",
            "rebate_settlement",
            "orders_claims",
            "withdraw",
            "invite",
            "account_privacy"
          ]
        },
        "faq": {
          "type": "boolean"
        },
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [
        "category"
      ],
      "additionalProperties": false
    }
  },
  "getArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "checkAppVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "getPage": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    }
  },
  "previewPage": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        }
      },
      "required": [
        "token"
      ],
      "additionalProperties": false
    }
  },
  "listPageSectionItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        },
        "section_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "page_key",
        "section_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getMessage": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    }
  },
  "listMessages": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "markMessagesRead": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "body": {
      "description": "Exactly one of message_ids (1–100 ids, duplicates counted once) or all=true.",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "message_ids"
          ],
          "properties": {
            "message_ids": {
              "type": "array",
              "minItems": 1,
              "maxItems": 100,
              "items": {
                "type": "string",
                "description": "Entity id, a UUIDv7 string (04 §5).",
                "minLength": 1,
                "maxLength": 64
              }
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "all"
          ],
          "properties": {
            "all": {
              "type": "boolean",
              "enum": [
                true
              ]
            }
          }
        }
      ]
    }
  },
  "getUnreadMessageCount": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "getWalletSummary": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "getEarningsSummary": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "listWalletLedger": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getWithdrawRules": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "amount_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 1
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "listWithdrawals": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "createWithdrawal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "maxLength": 2048
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "amount_fen"
      ],
      "properties": {
        "amount_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 1
        }
      }
    }
  },
  "getWithdrawal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "withdrawal_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "withdrawal_id"
      ],
      "additionalProperties": false
    }
  },
  "createPayOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "description": "No amount, title or identity field; the server prices the order (BR-PAY-01 ①).",
      "required": [
        "biz_type",
        "biz_ref",
        "pay_channel"
      ],
      "properties": {
        "biz_type": {
          "type": "string",
          "description": "A business type registered for payment (BR-PAY-01 ①); none is registered yet, so the\nserver refuses every value with 30901 reason=biz_not_sellable until one is.\n",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[a-z][a-z0-9_]*$"
        },
        "biz_ref": {
          "type": "string",
          "description": "The business object of biz_type the order pays for (one purchase per object, BR-PAY-02).",
          "minLength": 1,
          "maxLength": 64
        },
        "pay_channel": {
          "type": "string",
          "description": "Collection channel (enum pay_channel, BR-PAY-01); unrelated to payout_channel.",
          "enum": [
            "wechat_pay",
            "alipay"
          ]
        }
      }
    }
  },
  "getPayOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_order_id": {
          "type": "string",
          "format": "uuid"
        }
      },
      "required": [
        "pay_order_id"
      ],
      "additionalProperties": false
    }
  },
  "payOrderReturned": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_order_id": {
          "type": "string",
          "format": "uuid"
        }
      },
      "required": [
        "pay_order_id"
      ],
      "additionalProperties": false
    }
  },
  "cancelPayOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_order_id": {
          "type": "string",
          "format": "uuid"
        }
      },
      "required": [
        "pay_order_id"
      ],
      "additionalProperties": false
    }
  },
  "getMe": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "updateMe": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "nickname"
      ],
      "properties": {
        "nickname": {
          "type": "string",
          "description": "New nickname. The server trims leading and trailing white space and checks the length\nas 1–16 extended grapheme clusters (BR-ID-39); no minLength / maxLength here because\nJSON Schema counts code points.\n"
        }
      }
    }
  },
  "bindPhone": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "maxLength": 2048
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "code"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "code": {
          "type": "string",
          "description": "purpose=bind SMS code sent to the new number.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "bindInviter": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "invite_code"
      ],
      "properties": {
        "invite_code": {
          "type": "string",
          "description": "Invite code as typed or pasted. The server normalises it and checks the format\n(BR-INV-02); an empty or malformed code is 30401 and counts towards the daily limit, so\nthe schema has no pattern or minLength.\n",
          "maxLength": 64
        }
      }
    }
  },
  "getMyInvite": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "sendLandingSmsCode": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        }
      }
    }
  },
  "landingRegister": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "sms_code",
        "invite_code",
        "agreed"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "sms_code": {
          "type": "string",
          "description": "The purpose=login code from POST /v1/landing/sms-codes; a wrong or expired code is\n20002 / 20003 (BR-ID-05).\n",
          "maxLength": 64
        },
        "invite_code": {
          "type": "string",
          "description": "Invite code of the landing link. Normalised and checked by the server (BR-INV-02); an\nempty or malformed code is 30401 and counts towards the daily limit, so the schema has\nno pattern or minLength.\n",
          "maxLength": 64
        },
        "agreed": {
          "type": "boolean",
          "description": "The user agreement and privacy policy box was ticked. false is 10004 with\ndata.consent_type=agreement, not a validation error; on success the agreement and\nprivacy consents are recorded with channel h5_landing (BR-INV-05, BR-ID-32).\n"
        },
        "channel": {
          "type": "string",
          "description": "Optional channel code of the landing link, kept as the account's registered channel\n(BR-ID-04, BR-INV-05).\n",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      }
    }
  },
  "getReverify": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "reverifyByIdNumber": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id_no"
      ],
      "properties": {
        "id_no": {
          "type": "string",
          "description": "The resident ID number; its format is judged by the server (20001 data.fields=[id_no]).",
          "maxLength": 32
        }
      }
    }
  },
  "reverifyByOauth": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "description": "One provider with that provider's login credential fields and an attempt with\npurpose=reverify; no `action`. Each branch is a closed object.\n",
      "unevaluatedProperties": false,
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "provider",
            "attempt_id",
            "code"
          ],
          "properties": {
            "provider": {
              "type": "string",
              "enum": [
                "wechat"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "provider",
            "attempt_id",
            "identity_token",
            "authorization_code"
          ],
          "properties": {
            "provider": {
              "type": "string",
              "enum": [
                "apple"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "identity_token": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            },
            "authorization_code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "provider",
            "attempt_id",
            "authorization_code"
          ],
          "properties": {
            "provider": {
              "type": "string",
              "enum": [
                "huawei"
              ]
            },
            "attempt_id": {
              "type": "string",
              "description": "Entity id, a UUIDv7 string (04 §5).",
              "minLength": 1,
              "maxLength": 64
            },
            "authorization_code": {
              "type": "string",
              "description": "An authorization credential from the provider SDK; never stored or logged.",
              "minLength": 1,
              "maxLength": 4096
            }
          }
        }
      ]
    }
  },
  "getPayoutAccount": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "savePayoutAccount": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "maxLength": 2048
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "payout_method",
            "alipay_logon_id",
            "payee_name"
          ],
          "properties": {
            "payout_method": {
              "type": "string",
              "enum": [
                "alipay"
              ]
            },
            "alipay_logon_id": {
              "type": "string",
              "description": "Alipay logon id (phone or e-mail form), normalised by the server (BR-WDR-02 细则).",
              "minLength": 1,
              "maxLength": 128
            },
            "payee_name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "payout_method",
            "card_no",
            "payee_name"
          ],
          "properties": {
            "payout_method": {
              "type": "string",
              "enum": [
                "bank_card"
              ]
            },
            "card_no": {
              "type": "string",
              "description": "Card number as typed; the server removes spaces and hyphens, then checks 12–19 digits and\nLuhn (20001 data.fields=[card_no], BR-WDR-02 ⑥ and 细则).\n",
              "minLength": 1,
              "maxLength": 32
            },
            "bank_name": {
              "type": "string",
              "description": "Optional and ignored by the server: the opening bank is taken from the card BIN, the\nuser does not type it (BR-WDR-02 细则「只支持本人名下借记卡」). Accepted so that older\nclients sending it are not refused.\n",
              "minLength": 1,
              "maxLength": 64
            },
            "payee_name": {
              "type": "string",
              "description": "Account holder name (BR-WDR-02 ①).",
              "minLength": 1,
              "maxLength": 64
            }
          }
        }
      ]
    }
  },
  "submitRealname": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "name",
        "id_no"
      ],
      "properties": {
        "name": {
          "type": "string",
          "description": "Real name as typed; normalised by the server.",
          "minLength": 1,
          "maxLength": 64
        },
        "id_no": {
          "type": "string",
          "description": "18-digit resident ID number as typed. No pattern here: length and check digit are judged\nby the server (20001 data.fields=[id_no], BR-ID-25) after the phone and consent checks.\n",
          "maxLength": 32
        }
      }
    }
  },
  "getLaborAgreement": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "signLaborAgreement": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "text_sha256",
        "agreed"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "description": "The version shown to the user (GET /v1/me/labor-agreement); must be the current one."
        },
        "text_sha256": {
          "type": "string",
          "description": "sha256 of the text shown; must match that version (20001 data.fields=[text_sha256])."
        },
        "agreed": {
          "type": "boolean",
          "description": "Must be true; the server returns 20001 data.fields=[agreed] otherwise."
        }
      }
    }
  },
  "getTips": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "markTipRead": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "tip_key": {
          "type": "string",
          "description": "One-time tip (enum tip_key; BR-ATTR-21, BR-INV-03 细则). inviter_before_buy is deprecated\nsince 2026-10-19 (first-purchase inviter tip cancelled): kept and accepted as before, not\nused by clients, never reused.\n",
          "enum": [
            "jump_tip",
            "inviter_before_buy"
          ]
        }
      },
      "required": [
        "tip_key"
      ],
      "additionalProperties": false
    }
  },
  "resetTip": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "tip_key": {
          "type": "string",
          "description": "The tip that settings can show again (subset of tip_key).",
          "enum": [
            "jump_tip"
          ]
        }
      },
      "required": [
        "tip_key"
      ],
      "additionalProperties": false
    }
  },
  "getNotificationSettings": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "updateNotificationSettings": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "service_push",
        "subscription_push",
        "marketing_push"
      ],
      "properties": {
        "service_push": {
          "type": "boolean",
          "description": "Push of service messages (trades and withdrawals); the only switch shown in the MVP."
        },
        "subscription_push": {
          "type": "boolean",
          "description": "Push of subscription messages; reserved, not shown in the MVP."
        },
        "marketing_push": {
          "type": "boolean",
          "description": "Push of marketing messages; reserved, not shown in the MVP."
        }
      }
    }
  },
  "getDeletion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "requestDeletion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "maxLength": 2048
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    }
  },
  "cancelDeletion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "listMyDataCopies": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "getMyDataCopyDownload": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "listAppeals": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "submitAppeal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "target_type",
        "content"
      ],
      "properties": {
        "target_type": {
          "type": "string",
          "description": "Subset of contracts/enums/identity.yaml appeal_target_type (04 §6.1, BR-ID-36): the\nuser-side appeal endpoints take and return account and order only. blocked_request (a\nwrite request blocked with 44001) is registered by customer service in the admin console\nonly and is not accepted here (04 §3.2 appeals, §6.1; BR-ID-36 细则「被拦截请求申诉」).\n",
          "enum": [
            "account",
            "order"
          ]
        },
        "target_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "content": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  "abandonIdempotencyKey": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "action",
        "idempotency_key"
      ],
      "properties": {
        "action": {
          "type": "string",
          "description": "Action a step_up_token is bound to; one per x-step-up operation (04 §2.5, §5).",
          "enum": [
            "withdraw",
            "payout_account_change",
            "phone_change",
            "account_deletion"
          ]
        },
        "idempotency_key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      }
    }
  },
  "getConfig": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "if-none-match": {
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    }
  },
  "getDict": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "version": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "searchProducts": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "sort": {
          "type": "string",
          "description": "Search sort (contracts/enums/trade.yaml sort).",
          "enum": [
            "relevance",
            "sales_desc",
            "final_price_asc",
            "rebate_desc"
          ]
        },
        "has_coupon": {
          "type": "boolean"
        },
        "price_min_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 0
        },
        "price_max_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 0
        },
        "cursor": {
          "type": "string",
          "maxLength": 512
        },
        "limit": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 50,
          "default": 20
        }
      },
      "required": [
        "platform",
        "q"
      ],
      "additionalProperties": false
    }
  },
  "getProduct": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "product_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "item_ref": {
          "type": "string",
          "description": "Server-signed opaque product reference; passed through unchanged (BR-PROD-11).",
          "minLength": 1,
          "maxLength": 1024
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getProductPriceTrend": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "product_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [
        "platform"
      ],
      "additionalProperties": false
    }
  },
  "getHotRank": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "category": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "cursor": {
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [
        "platform"
      ],
      "additionalProperties": false
    }
  },
  "getSearchHotWords": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    }
  },
  "listFavorites": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "querystring": {
      "type": "object",
      "properties": {
        "cursor": {
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "addFavorite": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "platform",
        "product_key"
      ],
      "additionalProperties": false
    }
  },
  "removeFavorite": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "platform",
        "product_key"
      ],
      "additionalProperties": false
    }
  },
  "batchDeleteFavorites": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "items"
      ],
      "properties": {
        "items": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "platform",
              "product_key"
            ],
            "properties": {
              "platform": {
                "type": "string",
                "description": "Platform (contracts/enums/platform.yaml platform).",
                "enum": [
                  "taobao",
                  "jd",
                  "pdd",
                  "meituan",
                  "vip",
                  "douyin",
                  "eleme",
                  "kuaishou",
                  "suning"
                ]
              },
              "product_key": {
                "type": "string",
                "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
                "minLength": 3,
                "maxLength": 128
              }
            }
          }
        }
      }
    }
  },
  "parseInput": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign"
      ]
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "text",
        "scene"
      ],
      "properties": {
        "text": {
          "type": "string",
          "description": "Locally filtered clipboard or typed text (03 §4.6). Text outside links and tokens\nis untrusted (BR-AI-05); prices in it are only material.claimed_price_fen.\n",
          "minLength": 1,
          "maxLength": 4000
        },
        "scene": {
          "type": "string",
          "description": "Entry the text came from (subset of contracts/enums scene). Attribution-bearing\nscenes (share, agent, …) cannot be chosen by the client: share links come only from\nPOST /v1/shares (phone level), Agent cards from the Agent service (BR-ATTR-05, 08).\nshare_ext is P1.\n",
          "enum": [
            "clipboard",
            "search",
            "share_ext"
          ]
        }
      }
    }
  },
  "openLink": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "link_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "link_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "installed": {
          "description": "Default unknown; H5 always sends unknown (BR-ATTR-27 ①).",
          "type": "string",
          "enum": [
            "true",
            "false",
            "unknown"
          ]
        },
        "no_rebate": {
          "type": "boolean",
          "default": false,
          "description": "Buy without rebate (BR-ID-18)."
        },
        "no_rebate_reason": {
          "type": "string",
          "description": "Only with no_rebate=true; default auth_declined. The server overrides it with\nrelation_conflict / binding_blocked when it decides so (BR-ID-18).\n",
          "enum": [
            "auth_declined",
            "auth_failed"
          ]
        },
        "spm": {
          "type": "string",
          "description": "page.module.slot of the tapped button (03 §4.7).",
          "maxLength": 128
        }
      }
    }
  },
  "convertLink": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "description": "Either product_key (with the tapped card's item_ref) or url; neither, or both, is 20001.\nThe oneOf branches declare the property they require (strict Ajv2020, ADR-0001 §4.2 #15).\nA Taobao url is first resolved to an item_id and answered with a Baichuan open instruction\n(JumpStep.sdk); the pasted link or token itself is never passed on (BR-PRICE-21).\n",
      "additionalProperties": false,
      "required": [
        "platform",
        "scene"
      ],
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "product_key": {
              "type": "string",
              "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
              "minLength": 3,
              "maxLength": 128
            }
          },
          "required": [
            "product_key"
          ]
        },
        {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "format": "uri",
              "maxLength": 2048
            }
          },
          "required": [
            "url"
          ]
        }
      ],
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        },
        "item_ref": {
          "type": "string",
          "description": "Server-signed opaque product reference; passed through unchanged (BR-PROD-11).",
          "minLength": 1,
          "maxLength": 1024
        },
        "url": {
          "type": "string",
          "format": "uri",
          "maxLength": 2048
        },
        "scene": {
          "type": "string",
          "description": "Only the H5 entry (trade.convertAndOpen) uses convert (拍板第二批 TRADE-03); other\nscenes are rejected with 20001 so that the client cannot pick an attribution scene\nsuch as share (BR-ATTR-05, BR-ATTR-08).\n",
          "enum": [
            "h5"
          ]
        },
        "spm": {
          "type": "string",
          "maxLength": 128
        },
        "installed": {
          "description": "Default unknown; H5 always sends unknown (BR-ATTR-27 ①).",
          "type": "string",
          "enum": [
            "true",
            "false",
            "unknown"
          ]
        }
      }
    }
  },
  "getLink": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "link_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "link_id"
      ],
      "additionalProperties": false
    }
  },
  "getSharePage": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "link_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "link_id"
      ],
      "additionalProperties": false
    }
  },
  "getShareTpwd": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "link_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "link_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "ticket"
      ],
      "properties": {
        "ticket": {
          "type": "string",
          "description": "tpwd_ticket from GET /v1/share-pages/{link_id}.",
          "minLength": 1,
          "maxLength": 256
        }
      }
    }
  },
  "createShare": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "x-timestamp": {
          "type": "string",
          "pattern": "^[0-9]{10}$"
        },
        "x-nonce": {
          "type": "string",
          "pattern": "^[0-9a-f]{32}$"
        },
        "x-sign": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-sign",
        "idempotency-key"
      ]
    },
    "body": {
      "type": "object",
      "description": "Body of POST /v1/shares (04 §6.3). The share page only carries platform and product_key\n(plus the card's item_ref when it has one), whether it was opened from a card, ShareHub or\nthe favorites (BR-ATTR-10 细则「分享页与分享赚入口页」).\n",
      "additionalProperties": false,
      "required": [
        "platform",
        "product_key"
      ],
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        },
        "item_ref": {
          "type": "string",
          "description": "Server-signed opaque product reference; passed through unchanged (BR-PROD-11).",
          "minLength": 1,
          "maxLength": 1024
        },
        "source_link_id": {
          "description": "The link of the card the share page was opened from; only recorded as the source,\nnever changed and never used for sharing.\n",
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "adminLogin": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "username",
        "password"
      ],
      "properties": {
        "username": {
          "type": "string",
          "description": "Account name (unique; a disabled account keeps its name, BR-ID-43).",
          "minLength": 1,
          "maxLength": 64
        },
        "password": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      }
    }
  },
  "adminChangeInitialPassword": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket",
        "new_password"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        },
        "new_password": {
          "type": "string",
          "description": "Must differ from the initial password; composition rules are set by the server.",
          "minLength": 1,
          "maxLength": 128
        }
      }
    }
  },
  "adminGetTotpBindingSecret": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        }
      }
    }
  },
  "adminBindTotp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket",
        "code"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "adminVerifyTotp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "login_ticket",
        "code"
      ],
      "properties": {
        "login_ticket": {
          "type": "string",
          "description": "Intermediate credential of the admin login (BR-ID-34 细则「首次绑定身份验证器」): valid only for\nthe step it was issued for, sent in the request body, never an admin_token.\n",
          "minLength": 1,
          "maxLength": 2048
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "adminLogout": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminSendStepUpSms": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminStepUp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "tier",
        "code"
      ],
      "properties": {
        "tier": {
          "type": "string",
          "description": "Admin step-up tier (enum admin_step_up_tier, BR-ID-34).",
          "enum": [
            "totp",
            "sms"
          ]
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "adminGetMyPermissions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminSendMyVerifyPhoneCode": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        }
      }
    }
  },
  "adminChangeMyVerifyPhone": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "code"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        }
      }
    }
  },
  "adminListAdmins": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateAdmin": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "username",
        "display_name"
      ],
      "properties": {
        "username": {
          "type": "string",
          "description": "Login name; unique among all accounts, disabled ones included, and never changed (BR-ID-43).",
          "minLength": 1,
          "maxLength": 64
        },
        "display_name": {
          "type": "string",
          "description": "Admin display name (admin_users.display_name, 04 §3.2); trimmed by the server, 1–32 characters.",
          "minLength": 1,
          "maxLength": 32
        }
      }
    }
  },
  "adminGetAdmin": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    }
  },
  "adminRegenerateAdminInitialPassword": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    }
  },
  "adminDisableAdmin": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminEnableAdmin": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    }
  },
  "adminSaveAdminPermissions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "permissions",
        "expected_row_version"
      ],
      "properties": {
        "permissions": {
          "type": "array",
          "description": "The whole set of ticked points afterwards (enum admin_permission); empty unticks all.",
          "uniqueItems": true,
          "maxItems": 200,
          "items": {
            "type": "string",
            "description": "A value of contracts/enums/admin.yaml `admin_permission` (04 §11). Kept a string here so the\nlist lives in one place; clients ignore keys they do not know.\n",
            "minLength": 1,
            "maxLength": 64,
            "pattern": "^[a-z][a-z_]*(\\.[a-z_]+)*$"
          }
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
        }
      }
    }
  },
  "adminResetAdminTotp": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminUpdateAdminDisplayName": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "display_name"
      ],
      "properties": {
        "display_name": {
          "type": "string",
          "description": "Admin display name (admin_users.display_name, 04 §3.2); trimmed by the server, 1–32 characters.",
          "minLength": 1,
          "maxLength": 32
        }
      }
    }
  },
  "adminSendAdminVerifyPhoneCode": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        }
      }
    }
  },
  "adminChangeAdminVerifyPhone": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "admin_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "admin_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "phone",
        "code",
        "reason"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "code": {
          "type": "string",
          "description": "Current 6-digit code of the authenticator, or of the SMS for the sms tier.",
          "pattern": "^[0-9]{6}$"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminListAuditLogs": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "actor_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "target_type": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "target_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "permission": {
          "type": "string",
          "description": "A value of contracts/enums/admin.yaml `admin_permission` (04 §11). Kept a string here so the\nlist lives in one place; clients ignore keys they do not know.\n",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[a-z][a-z_]*(\\.[a-z_]+)*$"
        },
        "from": {
          "type": "string",
          "format": "date-time"
        },
        "to": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetAuditLog": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Opaque identifier of an audit record (04 §5, ids are strings). It is not the database\nprimary key (ADR-0001: internal auto-increment keys are never exposed); clients must not\nparse it, compare it for order or derive anything from it. Generated by the server and\nstable for the life of the record; how it is generated is up to the implementation.\n",
          "minLength": 16,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]{16,64}$"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "adminListExports": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "status": {
          "type": "string",
          "description": "Status of an export task (enum export_status; BR-ID-34 细则「后台导出任务」; names from\nBR-TEXT-25 admin_dict.export_status). pending → running → done or failed; done → expired\n24 hours after the file was generated; pending or running → cancelled when the creator's\naccount is disabled; failed → pending by a retry.\n",
          "enum": [
            "pending",
            "running",
            "done",
            "failed",
            "expired",
            "cancelled"
          ]
        },
        "resource": {
          "type": "string",
          "description": "Source list of an export task (enum export_resource): users = GET /admin/v1/users\n(needs user.list), audit_logs = GET /admin/v1/audit-logs (signed in is enough; own\nrecords only without audit.view_all), tax_withdrawals = the quarterly tax export of\nBR-WDR-21, which has no source list (see POST /admin/v1/exports).\n",
          "enum": [
            "users",
            "audit_logs",
            "tax_withdrawals"
          ]
        },
        "from": {
          "type": "string",
          "format": "date-time"
        },
        "to": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateExport": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "description": "One branch per source list (enum export_resource), told apart by `resource`; `filters`\nfollows that list's query parameters (`tax_withdrawals` has no list, only `quarter`).\n",
      "oneOf": [
        {
          "type": "object",
          "description": "Export of the users list. unmasked true asks for the full phone numbers (pii.reveal_phone,\ntotp step-up and reason required); reason is only accepted together with unmasked true.\n",
          "additionalProperties": false,
          "required": [
            "resource",
            "filters"
          ],
          "properties": {
            "resource": {
              "type": "string",
              "enum": [
                "users"
              ]
            },
            "filters": {
              "type": "object",
              "description": "Filters of a users export, the query parameters of GET /admin/v1/users without paging.",
              "additionalProperties": false,
              "properties": {
                "risk_state": {
                  "type": "string",
                  "description": "Risk state of a user (enum risk_state; BR-ID-31, BR-ID-36).",
                  "enum": [
                    "normal",
                    "frozen",
                    "appealing",
                    "banned"
                  ]
                }
              }
            },
            "unmasked": {
              "type": "boolean",
              "default": false,
              "description": "true = full values instead of the masked ones; absent or false = masked."
            },
            "reason": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "description": "Required free-text reason, kept in the audit record."
            }
          }
        },
        {
          "type": "object",
          "description": "Export of the audit log; always masked (audit values are stored masked), no reason.",
          "additionalProperties": false,
          "required": [
            "resource",
            "filters"
          ],
          "properties": {
            "resource": {
              "type": "string",
              "enum": [
                "audit_logs"
              ]
            },
            "filters": {
              "type": "object",
              "description": "Filters of an audit_logs export, the query parameters of GET /admin/v1/audit-logs without\npaging, judged the same way (without audit.view_all actor_id is forced to the creator;\nsystem rows match no actor_id filter).\n",
              "additionalProperties": false,
              "properties": {
                "actor_id": {
                  "type": "string",
                  "description": "Entity id, a UUIDv7 string (04 §5).",
                  "minLength": 1,
                  "maxLength": 64
                },
                "target_type": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 64
                },
                "target_id": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "permission": {
                  "type": "string",
                  "description": "A value of contracts/enums/admin.yaml `admin_permission` (04 §11). Kept a string here so the\nlist lives in one place; clients ignore keys they do not know.\n",
                  "minLength": 1,
                  "maxLength": 64,
                  "pattern": "^[a-z][a-z_]*(\\.[a-z_]+)*$"
                },
                "from": {
                  "type": "string",
                  "format": "date-time",
                  "description": "Earliest record time, inclusive."
                },
                "to": {
                  "type": "string",
                  "format": "date-time",
                  "description": "Latest record time, exclusive."
                }
              }
            }
          }
        },
        {
          "type": "object",
          "description": "Quarterly tax export (BR-WDR-21, see POST /admin/v1/exports). unmasked true\nasks for the full identity numbers (tax.export_full, totp step-up and reason required);\nreason is only accepted together with unmasked true.\n",
          "additionalProperties": false,
          "required": [
            "resource",
            "filters"
          ],
          "properties": {
            "resource": {
              "type": "string",
              "enum": [
                "tax_withdrawals"
              ]
            },
            "filters": {
              "type": "object",
              "description": "Filters of a tax_withdrawals export (BR-WDR-21).",
              "additionalProperties": false,
              "required": [
                "quarter"
              ],
              "properties": {
                "quarter": {
                  "type": "string",
                  "pattern": "^\\d{4}-Q[1-4]$",
                  "description": "Natural quarter by paid_at at +08:00, as YYYY-Qn. The year is 2026..2100; another year\nis 20001.\n"
                }
              }
            },
            "unmasked": {
              "type": "boolean",
              "default": false,
              "description": "true = full values instead of the masked ones; absent or false = masked."
            },
            "reason": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "description": "Required free-text reason, kept in the audit record."
            }
          }
        }
      ]
    }
  },
  "adminDownloadExport": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Opaque identifier of an export task (04 §5, ids are strings). It is not the database\nprimary key (ADR-0001: internal auto-increment keys are never exposed); clients must not\nparse it, compare it for order or derive anything from it. Generated by the server and\nstable for the life of the task, retries included; how it is generated is up to the\nimplementation.\n",
          "minLength": 16,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]{16,64}$"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "adminRetryExport": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Opaque identifier of an export task (04 §5, ids are strings). It is not the database\nprimary key (ADR-0001: internal auto-increment keys are never exposed); clients must not\nparse it, compare it for order or derive anything from it. Generated by the server and\nstable for the life of the task, retries included; how it is generated is up to the\nimplementation.\n",
          "minLength": 16,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]{16,64}$"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Empty for a masked task. For an unmasked task (masked false) reason is required, with a\nnew totp-tier X-Step-Up-Token; for a masked task reason is 20001.\n",
      "additionalProperties": false,
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminListUsers": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "risk_state": {
          "type": "string",
          "description": "Risk state of a user (enum risk_state; BR-ID-31, BR-ID-36).",
          "enum": [
            "normal",
            "frozen",
            "appealing",
            "banned"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminLookupUser": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "uid": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetUser": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  "adminRevealUserField": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "field",
        "reason"
      ],
      "properties": {
        "field": {
          "type": "string",
          "description": "The sensitive field to show in full. Only phone (permission point pii.reveal_phone) for\nnow; the identity number and payout account (pii.reveal_identity) come later.\n",
          "enum": [
            "phone"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminUpdateUserRiskState": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "action",
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "action": {
          "type": "string",
          "description": "ban and unban (permission point risk.ban), freeze and unfreeze (risk.freeze); 04 §11.2,\nBR-ID-31, BR-ID-36.\n",
          "enum": [
            "ban",
            "unban",
            "freeze",
            "unfreeze"
          ]
        },
        "reason_category": {
          "allOf": [
            {
              "type": "string",
              "description": "User-visible reason category of a ban or freeze (enum risk_reason_category; BR-TEXT-23 细则\n「原因类别」, user text from the dictionary risk_reason.<category>).\n",
              "enum": [
                "malicious_rights",
                "fraud_invite",
                "abnormal_trade",
                "account_security",
                "other"
              ]
            }
          ],
          "description": "Required for ban and freeze; not accepted for unban and unfreeze (20001)."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "frozen_until": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "Only for freeze: end of the freeze, later than the server's current time; null or\nabsent = without end (BR-ID-36). Given with another action → 20001.\n"
        },
        "expected_row_version": {
          "anyOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
            },
            {
              "type": "null"
            }
          ],
          "description": "risk.row_version as the console showed it; null = no row seen, only accepted while the\nuser still has no row. Any mismatch (null against an existing row, an integer against\nno row or another version) is 20902.\n"
        }
      }
    }
  },
  "adminResetUserUnionBinding": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [
        "user_id",
        "platform"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The binding's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminDisableUserUnionBinding": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [
        "user_id",
        "platform"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The binding's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminEnableUserUnionBinding": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [
        "user_id",
        "platform"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "reason",
        "expected_row_version"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The binding's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminEditUserProfile": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of PATCH /admin/v1/users/{user_id}/profile (BR-ID-06 细则「客服代办换号」, BR-ID-39\n细则「后台改昵称」): `reason` and at least one of `phone` and `nickname`.\n",
      "additionalProperties": false,
      "required": [
        "reason"
      ],
      "minProperties": 2,
      "properties": {
        "phone": {
          "allOf": [
            {
              "type": "string",
              "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
            }
          ],
          "description": "The new phone number, normalised by the server (BR-ID-05 细则「手机号规范化」); equal to\nthe current number after normalisation means not edited.\n"
        },
        "nickname": {
          "type": "string",
          "description": "The new nickname. The server trims leading and trailing white space and checks the\nlength as 1–16 extended grapheme clusters (BR-ID-39); no minLength / maxLength here\nbecause JSON Schema counts code points. Equal to the current nickname after trimming\nmeans not edited.\n"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminCorrectUserRealname": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Corrected real-name data submitted by customer service (BR-ID-25 细则「实名更正」).",
      "additionalProperties": false,
      "required": [
        "name",
        "id_no",
        "reason"
      ],
      "properties": {
        "name": {
          "type": "string",
          "description": "Corrected real name as typed; normalised by the server. Never logged or audited in plaintext.",
          "minLength": 1,
          "maxLength": 64
        },
        "id_no": {
          "type": "string",
          "description": "Corrected 18-digit resident ID number as typed. No pattern here: length and check\ndigit are judged by the server (20001 data.fields=[id_no]) after the not-accepted\nchecks. Never logged or audited in plaintext.\n",
          "maxLength": 32
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        }
      }
    }
  },
  "adminListUserDataExports": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateUserDataExport": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Registration of a personal information copy request (04 §6.6 users/{id}/data-exports).\nThe two channel facts decide the delivery: both true → in_app_sms, both false →\nwecom_session, only one true → not accepted (pending legal confirmation, BR-ID-40).\n",
      "additionalProperties": false,
      "required": [
        "reason",
        "app_login_ok",
        "phone_sms_ok"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Required free-text reason, kept in the audit record."
        },
        "app_login_ok": {
          "type": "boolean",
          "description": "The agent confirmed in the conversation that the user can sign in to the App."
        },
        "phone_sms_ok": {
          "type": "boolean",
          "description": "The agent confirmed in the conversation that the bound phone number can receive SMS."
        }
      }
    }
  },
  "adminDownloadUserDataExport": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "export_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "user_id",
        "export_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of a wecom_session download; empty for an ordinary download.",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "regenerate": {
          "type": "boolean",
          "default": false,
          "description": "true = re-encrypt a new file with a new password and void the previous file\n(the password was lost); due_at and expires_at do not change.\n"
        }
      }
    }
  },
  "adminListOrders": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "platform_status": {
          "type": "string",
          "description": "Union order status (contracts/enums/order.yaml platform_status; BR-FUND-01, BR-FUND-02).",
          "enum": [
            "DEPOSIT_PAID",
            "PAID",
            "RECEIVED",
            "SETTLED",
            "INVALID"
          ]
        },
        "rebate_status": {
          "type": "string",
          "description": "Rebate status (contracts/enums/order.yaml rebate_status; BR-FUND-01).",
          "enum": [
            "UNATTRIBUTED",
            "ESTIMATED",
            "WAITING",
            "CREDITED",
            "VOID",
            "CLAWED_BACK"
          ]
        },
        "flag": {
          "type": "string",
          "description": "A flag of an admin order row (enum admin_order_flag); the keys of AdminOrderFlags.",
          "enum": [
            "locked",
            "status_locked",
            "rights_pending",
            "hold"
          ]
        },
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "q": {
          "type": "string"
        },
        "paid_from": {
          "type": "string",
          "format": "date-time"
        },
        "paid_to": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "order_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminHoldOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "order_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/orders/{order_id}/hold. `reason_code` may be left out when it can be\nderived from the operator's permission points (BR-FUND-06 细则「后台 hold / unhold」).\n",
      "additionalProperties": false,
      "required": [
        "note",
        "expected_row_version"
      ],
      "properties": {
        "reason_code": {
          "type": "string",
          "description": "The hold reason an operator may send to hold / unhold (subset of enum order_hold_reason):\nRISK or CS. UNMAPPED_STATUS is set by the system alone (BR-FUND-02, BR-FUND-06 细则「后台\nhold / unhold」).\n",
          "enum": [
            "RISK",
            "CS"
          ]
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The operator's note (说明), required, 1–200 characters; written into the audit record."
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The order's row_version from GET /admin/v1/orders/{order_id}."
        }
      }
    }
  },
  "adminUnholdOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "order_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/orders/{order_id}/unhold; `reason_code` is required.",
      "additionalProperties": false,
      "required": [
        "reason_code",
        "note",
        "expected_row_version"
      ],
      "properties": {
        "reason_code": {
          "type": "string",
          "description": "The hold reason an operator may send to hold / unhold (subset of enum order_hold_reason):\nRISK or CS. UNMAPPED_STATUS is set by the system alone (BR-FUND-02, BR-FUND-06 细则「后台\nhold / unhold」).\n",
          "enum": [
            "RISK",
            "CS"
          ]
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The operator's note (说明), required, 1–200 characters; written into the audit record."
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The order's row_version from GET /admin/v1/orders/{order_id}."
        }
      }
    }
  },
  "adminReassignOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "order_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/orders/{order_id}/reassign (BR-ATTR-31).",
      "additionalProperties": false,
      "required": [
        "user_id",
        "expected_user_id",
        "expected_locked",
        "reason"
      ],
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "expected_user_id": {
          "type": "null",
          "description": "The order's user_id as the operator saw it; only null (an unattributed order)."
        },
        "expected_locked": {
          "type": "boolean",
          "description": "The order's flags.locked as the operator saw it."
        },
        "reason": {
          "type": "string",
          "minLength": 5,
          "maxLength": 200,
          "description": "Why the order is assigned (5–200 characters, BR-ATTR-20 ③); written into the audit record."
        }
      }
    }
  },
  "adminListOrderSyncs": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateOrderSync": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/order-syncs; exactly one of the two forms. By time window:\n`platform`, `from`, `to` and an optional `status_filter`; `from` must be before `to` and not\nearlier than the platform's earliest_from (the look-back range of 02 §7.1; GET\n/admin/v1/order-syncs/limits), checked by the handler (20001). By order numbers:\n`platform` and `order_nos` (the 【同步此单】 of the order detail sends one). The fields are\ndeclared once here and the `oneOf` only picks the form, so a value out of range (such as\nmore than 50 order numbers) names just that field.\n",
      "additionalProperties": false,
      "required": [
        "platform"
      ],
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "from": {
          "type": "string",
          "format": "date-time",
          "description": "Window start, inclusive (ISO 8601 with offset); time window form only."
        },
        "to": {
          "type": "string",
          "format": "date-time",
          "description": "Window end, exclusive (ISO 8601 with offset); time window form only."
        },
        "status_filter": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "The order status filter of the platform's order query (status_filter), only a value\nregistered for that platform in specs/union/<platform>.md; an unregistered value is 20001\nwith data.fields=[status_filter]. Not the status of the sync request.\n"
        },
        "order_nos": {
          "type": "array",
          "description": "Sub-order numbers, 1–50 (01 F-ORD-10).",
          "minItems": 1,
          "maxItems": 50,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        }
      },
      "oneOf": [
        {
          "title": "AdminOrderSyncByWindow",
          "required": [
            "from",
            "to"
          ],
          "properties": {
            "from": {},
            "to": {},
            "order_nos": {
              "not": {}
            }
          }
        },
        {
          "title": "AdminOrderSyncByOrderNos",
          "required": [
            "order_nos"
          ],
          "properties": {
            "order_nos": {},
            "from": {
              "not": {}
            },
            "to": {
              "not": {}
            },
            "status_filter": {
              "not": {}
            }
          }
        }
      ]
    }
  },
  "adminGetOrderSyncLimits": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminListRightsImports": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateRightsImport": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "multipart": true
  },
  "adminGetRightsImport": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "import_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "import_id"
      ],
      "additionalProperties": false
    }
  },
  "adminListClaims": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "evidence_level": {
          "type": "string",
          "description": "Evidence level of a claim or of one child order (contracts/enums/order.yaml claim_evidence_level; BR-ATTR-18).",
          "enum": [
            "strong",
            "weak",
            "none"
          ]
        },
        "status": {
          "type": "string",
          "description": "Claim status (contracts/enums/order.yaml claim_status; BR-ATTR-16, BR-ATTR-18).",
          "enum": [
            "submitted",
            "auto_matched",
            "manual_review",
            "approved",
            "rejected",
            "cancelled"
          ]
        },
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "q": {
          "type": "string"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminGetClaim": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "claim_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "claim_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminApproveClaimItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "claim_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "item_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "claim_id",
        "item_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_row_version",
        "reason"
      ],
      "properties": {
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The child order's row_version as the console showed it; a mismatch is 20902 (claim_item)."
        },
        "reason": {
          "type": "string",
          "minLength": 5,
          "maxLength": 200,
          "description": "The review note, required for approval and rejection (BR-ATTR-20: at least 5\ncharacters); at least 5 characters also after trimming surrounding whitespace, stored\ntrimmed in claims.reason and the audit log.\n"
        }
      }
    }
  },
  "adminRejectClaimItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "claim_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "item_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "claim_id",
        "item_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_row_version",
        "reason",
        "reject_reason"
      ],
      "properties": {
        "expected_row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
            }
          ],
          "description": "The child order's row_version as the console showed it; a mismatch is 20902 (claim_item)."
        },
        "reason": {
          "type": "string",
          "minLength": 5,
          "maxLength": 200,
          "description": "The review note, required for approval and rejection (BR-ATTR-20: at least 5\ncharacters); at least 5 characters also after trimming surrounding whitespace, stored\ntrimmed in claims.reason and the audit log.\n"
        },
        "reject_reason": {
          "type": "string",
          "description": "The reject reasons a reviewer may choose (enum claim_reject_reason, its first six codes;\nBR-ATTR-18). NOT_IN_POOL and ORDER_INVALID are set by the system only.\n",
          "enum": [
            "NO_EVIDENCE",
            "EXPIRED_CLICK",
            "NOT_TRACKED",
            "OTHER_TLJ",
            "FRAUD",
            "OTHER"
          ]
        }
      }
    }
  },
  "adminListUnionAccounts": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminStartUnionReauthorization": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "union_account_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "union_account_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/union-accounts/{union_account_id}/reauthorize; may be empty.",
      "additionalProperties": false,
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record (BR-ID-24 细则, BR-ATTR-02 细则)."
        }
      }
    }
  },
  "adminGetUnionReauthorization": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "union_account_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "session_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "union_account_id",
        "session_id"
      ],
      "additionalProperties": false
    }
  },
  "adminCompleteUnionReauthorization": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/union-accounts/oauth/callback: what the console callback page\nreceived from the union, unchanged: `state` and exactly one of `code` or `error`\n(neither or both → 20001 with `data.fields=[code]`).\n",
      "additionalProperties": false,
      "required": [
        "state"
      ],
      "minProperties": 2,
      "maxProperties": 2,
      "properties": {
        "state": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512,
          "description": "The state the union echoed back; looked up by its hash."
        },
        "code": {
          "type": "string",
          "writeOnly": true,
          "minLength": 1,
          "maxLength": 1024,
          "description": "The authorization code from the union; exchanged once, never logged or returned."
        },
        "error": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The error the union sent instead of a code; kept as the session's failure cause."
        }
      }
    }
  },
  "adminPutUnionCredential": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "union_account_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "union_account_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of PUT /admin/v1/union-accounts/{union_account_id}/credential (reauth_mode manual).",
      "additionalProperties": false,
      "required": [
        "credential"
      ],
      "properties": {
        "credential": {
          "type": "string",
          "writeOnly": true,
          "minLength": 1,
          "maxLength": 512,
          "pattern": "^\\S(.*\\S)?$",
          "description": "The new station-owner credential in plaintext; only encrypted, never returned or logged."
        },
        "expires_at": {
          "type": "string",
          "format": "date-time",
          "description": "Expiry shown by the union, later than now; absent → now + the platform's Key validity from the platform registry (not fixed), marked estimated."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record (BR-ID-24 细则, BR-ATTR-02 细则)."
        }
      }
    }
  },
  "adminListUnionAlertPhones": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminAddUnionAlertPhone": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/union-accounts/alert-phones.",
      "additionalProperties": false,
      "required": [
        "phone",
        "expected_version"
      ],
      "properties": {
        "phone": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "description": "The number as entered; normalized by BR-ID-05 细则 before checking."
        },
        "expected_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
            }
          ],
          "description": "The `version` of the list as the console showed it; a mismatch is 20902."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record (BR-ID-24 细则, BR-ATTR-02 细则)."
        }
      }
    }
  },
  "adminRemoveUnionAlertPhone": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "phone_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[A-Za-z0-9_-]+$",
          "description": "Identifier of one alert phone, the HMAC of the normalized number as the server encodes it; opaque to the console."
        },
        "expected_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
        }
      },
      "required": [
        "phone_id",
        "expected_version"
      ],
      "additionalProperties": false
    }
  },
  "adminListUnionAccountOptions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminListUnionPids": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminCreateUnionPid": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/union-pids; the new row is always pending.",
      "additionalProperties": false,
      "required": [
        "platform",
        "union_account_id",
        "pid",
        "pid_scene"
      ],
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "union_account_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "site_id": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 64,
              "pattern": "^[0-9A-Za-z_-]+$",
              "description": "A union-side identifier (pid / adzone / positionId, or the taobao site_id) as the union shows it."
            },
            {
              "type": "null"
            }
          ],
          "description": "Required for taobao; absent or null on every other platform."
        },
        "pid": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[0-9A-Za-z_-]+$",
          "description": "A union-side identifier (pid / adzone / positionId, or the taobao site_id) as the union shows it."
        },
        "pid_scene": {
          "type": "string",
          "description": "PID scene (enum pid_scene; 04 §2.2, BR-ATTR-08).",
          "enum": [
            "self_buy",
            "agent",
            "share",
            "taolijin",
            "fallback",
            "query"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record (BR-ID-24 细则, BR-ATTR-02 细则)."
        }
      }
    }
  },
  "adminUpdateUnionPid": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pid_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pid_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of PATCH /admin/v1/union-pids/{pid_id} (pending rows only): `expected_row_version`\nplus at least one more field; a body that names none of the five fields (only\n`expected_row_version` and `reason`) is 20001 with `data.fields=[body]`.\n",
      "additionalProperties": false,
      "required": [
        "expected_row_version"
      ],
      "minProperties": 2,
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "union_account_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "site_id": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 64,
              "pattern": "^[0-9A-Za-z_-]+$",
              "description": "A union-side identifier (pid / adzone / positionId, or the taobao site_id) as the union shows it."
            },
            {
              "type": "null"
            }
          ],
          "description": "The taobao site id; null clears it when the row moves to another platform."
        },
        "pid": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[0-9A-Za-z_-]+$",
          "description": "A union-side identifier (pid / adzone / positionId, or the taobao site_id) as the union shows it."
        },
        "pid_scene": {
          "type": "string",
          "description": "PID scene (enum pid_scene; 04 §2.2, BR-ATTR-08).",
          "enum": [
            "self_buy",
            "agent",
            "share",
            "taolijin",
            "fallback",
            "query"
          ]
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record (BR-ID-24 细则, BR-ATTR-02 细则)."
        }
      }
    }
  },
  "adminActivateUnionPid": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pid_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pid_id"
      ],
      "additionalProperties": false
    },
    "multipart": true
  },
  "adminRetireUnionPid": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pid_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pid_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/union-pids/{pid_id}/retire.",
      "additionalProperties": false,
      "required": [
        "expected_row_version"
      ],
      "properties": {
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "row_version of the row as read (users' risk state, a union binding, an admin account);\nplus 1 on every change. The CAS value `expected_row_version` of the writes.\n"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record (BR-ID-24 细则, BR-ATTR-02 细则)."
        }
      }
    }
  },
  "adminListPlatformIcons": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminListPlatformIconVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreatePlatformIconVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "upload_id"
      ],
      "properties": {
        "upload_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "sanitized_confirmed": {
          "type": "boolean",
          "description": "The operator confirmed the cleaned preview; absent means false. Must be true when the\nupload has sanitized=true.\n"
        },
        "source_url": {
          "type": "string",
          "format": "uri",
          "pattern": "^https?://",
          "maxLength": 2048,
          "description": "Official brand or asset download page the file was taken from (BR-TEXT-24 细则「必填登记」)."
        },
        "downloaded_on": {
          "type": "string",
          "format": "date"
        }
      }
    }
  },
  "adminUploadPlatformIcon": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "multipart": true
  },
  "adminUpdatePlatformIconVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        },
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [
        "key",
        "version"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "The version's revision as shown plus at least one of the two registrations.",
      "additionalProperties": false,
      "required": [
        "expected_revision"
      ],
      "minProperties": 2,
      "properties": {
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The version's `revision` as the console showed it; a mismatch is 20902."
        },
        "source_url": {
          "type": "string",
          "format": "uri",
          "pattern": "^https?://",
          "maxLength": 2048,
          "description": "Official brand or asset download page the file was taken from (BR-TEXT-24 细则「必填登记」)."
        },
        "downloaded_on": {
          "type": "string",
          "format": "date"
        }
      }
    }
  },
  "adminPublishPlatformIcon": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "expected_revision"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Version to publish; older than the current one = rollback."
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The mark's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminRestoreBuiltinPlatformIcon": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "Platform mark key (enum platform_icon_key, BR-TEXT-24 细则标识键表); the keys of /v1/config\n`platform_icons` (ConfigPlatformIcons) are the same list.\n",
          "enum": [
            "taobao",
            "tmall",
            "jd",
            "pdd",
            "wechat",
            "wechat_pay",
            "alipay",
            "wecom"
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_revision"
      ],
      "properties": {
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The mark's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminListPageConfigs": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminUploadPopupAsset": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "multipart": true
  },
  "adminGetPageConfig": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    }
  },
  "adminListPageConfigVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreatePageConfigVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "sections",
        "expected_revision"
      ],
      "properties": {
        "sections": {
          "type": "array",
          "description": "The whole page; section shape contracts/home-schema.json `$defs/section`.",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it, 0 for a page not saved yet; a mismatch is 20902."
        }
      }
    }
  },
  "adminGetPageConfigVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        },
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [
        "page_key",
        "version"
      ],
      "additionalProperties": false
    }
  },
  "adminPublishPageConfig": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "gray_percent",
        "expected_revision"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Draft version to publish."
        },
        "gray_percent": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 100,
          "description": "100 = release fully; 1..99 = gray rollout to that share of devices."
        },
        "publish_at": {
          "type": "string",
          "format": "date-time",
          "description": "Scheduled publish time, later than now and at most 30 days after now; absent = publish\nnow.\n"
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminCancelPageConfigSchedule": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0
        }
      },
      "required": [
        "expected_revision"
      ],
      "additionalProperties": false
    }
  },
  "adminUpdatePageConfigGray": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "gray_percent",
        "expected_revision"
      ],
      "properties": {
        "gray_percent": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 100,
          "description": "New share of devices on the gray version; 100 = release the gray version fully."
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminRollbackPageConfig": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "expected_revision"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The current gray version or the current fully released version."
        },
        "expected_revision": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The page's `revision` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminCreatePagePreviewToken": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "page_key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^(home|custom:[a-z0-9_-]{1,57})$"
        }
      },
      "required": [
        "page_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Version to preview, in any status."
        }
      }
    }
  },
  "adminListAgreements": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type; 01 §4.2). sdk_list (the SDK list) and collect_list\n(the personal information collection list) are versioned public notices only: published\nlike the others (BR-ID-12) but taking no part in consent (D10-465) — min_version always\nequals version, never in first-launch consent, re-consent or re-signing, and never listed\nby GET /v1/agreements. Consent and signing fields keep their own types without these two.\n",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement",
            "sdk_list",
            "collect_list"
          ]
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminPublishAgreementVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type; 01 §4.2). sdk_list (the SDK list) and collect_list\n(the personal information collection list) are versioned public notices only: published\nlike the others (BR-ID-12) but taking no part in consent (D10-465) — min_version always\nequals version, never in first-launch consent, re-consent or re-signing, and never listed\nby GET /v1/agreements. Consent and signing fields keep their own types without these two.\n",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement",
            "sdk_list",
            "collect_list"
          ]
        }
      },
      "required": [
        "type"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "title",
        "body",
        "min_version",
        "requires_resign",
        "legal_confirmed_by",
        "legal_confirm_note",
        "legal_confirmed_on",
        "expected_version"
      ],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200000,
          "description": "tiptap JSON of the text, as a string; nodes and marks outside the agreement body whitelist are 20001 with data.fields=[body]."
        },
        "min_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "Where re-consent or re-signing starts; not below the current version's, not above the new version; for sdk_list and collect_list exactly the new version (D10-465)."
        },
        "requires_resign": {
          "type": "boolean",
          "description": "Whether the new version requires a new signature; must agree with the publish rules for the type and min_version."
        },
        "legal_confirmed_by": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "Who confirmed the version for legal (OPS-14)."
        },
        "legal_confirm_note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500,
          "description": "The legal confirmation note (OPS-14)."
        },
        "legal_confirmed_on": {
          "type": "string",
          "format": "date",
          "description": "Date of the legal confirmation, written to the audit record (BR-ID-12)."
        },
        "expected_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The type's newest version as the console showed it, 0 when none is published; a mismatch is 20902."
        }
      }
    }
  },
  "adminGetAgreementVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "description": "Agreement type (04 §6.2 agreements.type; 01 §4.2). sdk_list (the SDK list) and collect_list\n(the personal information collection list) are versioned public notices only: published\nlike the others (BR-ID-12) but taking no part in consent (D10-465) — min_version always\nequals version, never in first-launch consent, re-consent or re-signing, and never listed\nby GET /v1/agreements. Consent and signing fields keep their own types without these two.\n",
          "enum": [
            "privacy",
            "agreement",
            "labor_agreement",
            "sdk_list",
            "collect_list"
          ]
        },
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1
        }
      },
      "required": [
        "type",
        "version"
      ],
      "additionalProperties": false
    }
  },
  "adminListProductPools": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "description": "Pool status; a disabled pool is read as empty (编排者默认).",
          "enum": [
            "active",
            "disabled"
          ]
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateProductPool": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/product-pools.",
      "additionalProperties": false,
      "required": [
        "pool_id",
        "name"
      ],
      "properties": {
        "pool_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "description": "Name shown in the console (编排者默认 1–64 characters).",
          "minLength": 1,
          "maxLength": 64
        },
        "status": {
          "type": "string",
          "description": "Pool status; a disabled pool is read as empty (编排者默认).",
          "enum": [
            "active",
            "disabled"
          ]
        }
      }
    }
  },
  "adminSearchPoolCandidates": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        },
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "cursor": {
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [
        "platform",
        "q"
      ],
      "additionalProperties": false
    }
  },
  "adminGetProductPool": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pool_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pool_id"
      ],
      "additionalProperties": false
    }
  },
  "adminUpdateProductPool": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pool_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pool_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of PATCH /admin/v1/product-pools/{pool_id}: `expected_revision` plus at least one\nof `name` and `status`.\n",
      "additionalProperties": false,
      "required": [
        "expected_revision"
      ],
      "minProperties": 2,
      "properties": {
        "name": {
          "type": "string",
          "description": "Name shown in the console (编排者默认 1–64 characters).",
          "minLength": 1,
          "maxLength": 64
        },
        "status": {
          "type": "string",
          "description": "Pool status; a disabled pool is read as empty (编排者默认).",
          "enum": [
            "active",
            "disabled"
          ]
        },
        "expected_revision": {
          "type": "integer",
          "format": "int64",
          "minimum": 0
        }
      }
    }
  },
  "adminListPoolItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pool_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pool_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "description": "Shelf status of a pool item (BR-PROD-08 ③).",
          "enum": [
            "online",
            "offline"
          ]
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminAddPoolItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pool_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pool_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/product-pools/{pool_id}/items: exactly one of `link_text` and\n`item_ref`, plus `sort`, `start_at` and `end_at`. The oneOf branches declare the property\nthey require (strict Ajv2020, ADR-0001 §4.2 #15).\n",
      "additionalProperties": false,
      "required": [
        "sort",
        "start_at",
        "end_at"
      ],
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "link_text": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4000
            }
          },
          "required": [
            "link_text"
          ]
        },
        {
          "type": "object",
          "properties": {
            "item_ref": {
              "type": "string",
              "description": "Server-signed opaque product reference; passed through unchanged (BR-PROD-11).",
              "minLength": 1,
              "maxLength": 1024
            }
          },
          "required": [
            "item_ref"
          ]
        }
      ],
      "properties": {
        "link_text": {
          "type": "string",
          "description": "A link or token, resolved as parseInput resolves it.",
          "minLength": 1,
          "maxLength": 4000
        },
        "item_ref": {
          "type": "string",
          "description": "Server-signed opaque product reference; passed through unchanged (BR-PROD-11).",
          "minLength": 1,
          "maxLength": 1024
        },
        "sort": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "Ascending; lower comes first."
        },
        "start_at": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "end_at": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        }
      }
    }
  },
  "adminRemovePoolItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pool_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "pool_id",
        "product_key"
      ],
      "additionalProperties": false
    }
  },
  "adminUpdatePoolItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pool_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "product_key": {
          "type": "string",
          "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
          "minLength": 3,
          "maxLength": 128
        }
      },
      "required": [
        "pool_id",
        "product_key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of PATCH /admin/v1/product-pools/{pool_id}/items/{product_key}.",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "sort": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "Ascending; lower comes first."
        },
        "start_at": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "end_at": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "status": {
          "type": "string",
          "description": "Shelf status of a pool item (BR-PROD-08 ③).",
          "enum": [
            "online",
            "offline"
          ]
        }
      }
    }
  },
  "adminListArticles": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "category": {
          "type": "string",
          "description": "Article category (04 §6.2：帮助、规则、公告、协议; codes defined here, no enums/ entry yet).",
          "enum": [
            "help",
            "rule",
            "notice",
            "agreement"
          ]
        },
        "status": {
          "type": "string",
          "description": "Status of one article version row (04 §6.2): draft = saved, never published; published =\npublished (counts only once published_at is not later than now); offline = taken offline.\n",
          "enum": [
            "draft",
            "published",
            "offline"
          ]
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminCreateArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "article_id",
        "category",
        "title",
        "body"
      ],
      "properties": {
        "article_id": {
          "description": "Client-generated UUIDv7 (lowercase canonical form), generated once per new article and\nreused on every retry of the same create. An id that already exists → 20902\n`data.resource=article` (no second article); read it back with GET\n/admin/v1/articles/{article_id}.\n",
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "category": {
          "type": "string",
          "description": "Article category (04 §6.2：帮助、规则、公告、协议; codes defined here, no enums/ entry yet).",
          "enum": [
            "help",
            "rule",
            "notice",
            "agreement"
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200000,
          "description": "tiptap JSON document as a string."
        },
        "notice_closable": {
          "type": "boolean",
          "description": "Notices only (default true); ignored for other categories."
        },
        "notice_end_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "Notices only; required when notice_closable is false. Ignored for other categories."
        },
        "help_section": {
          "description": "Help articles only; omitted = no sub-section. Not nullable. Sent with a category\nother than help → 20001 `data.fields` containing help_section.\n",
          "type": "string",
          "enum": [
            "getting_started",
            "rebate_settlement",
            "orders_claims",
            "withdraw",
            "invite",
            "account_privacy"
          ]
        },
        "faq_rank": {
          "description": "Help articles only; omitted = not in the 「常见问题」 list. Not nullable. Sent with a\ncategory other than help → 20001 `data.fields` containing faq_rank.\n",
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 999
        }
      }
    }
  },
  "adminGetArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    }
  },
  "adminSaveArticleDraft": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "title",
        "body",
        "expected_row_version"
      ],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200000,
          "description": "tiptap JSON document as a string."
        },
        "notice_closable": {
          "type": "boolean",
          "description": "Notices only (default true); ignored for other categories."
        },
        "notice_end_at": {
          "type": [
            "string",
            "null"
          ],
          "format": "date-time",
          "description": "Notices only; required when notice_closable is false. Ignored for other categories."
        },
        "help_section": {
          "description": "Help articles only; omitted = no sub-section (a draft is a whole new version row, so\nomitting it clears the value). Not nullable. Sent with a category other than help →\n20001 `data.fields` containing help_section.\n",
          "type": "string",
          "enum": [
            "getting_started",
            "rebate_settlement",
            "orders_claims",
            "withdraw",
            "invite",
            "account_privacy"
          ]
        },
        "faq_rank": {
          "description": "Help articles only; omitted = not in the 「常见问题」 list (a draft is a whole new\nversion row, so omitting it clears the value). Not nullable. Sent with a category\nother than help → 20001 `data.fields` containing faq_rank.\n",
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 999
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The article's `row_version` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminPublishArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "expected_row_version"
      ],
      "properties": {
        "version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The newest version, in status draft."
        },
        "published_at": {
          "type": "string",
          "format": "date-time",
          "description": "When the version takes effect; default now, earlier than now is 20001."
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The article's `row_version` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminOfflineArticle": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "article_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "article_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_row_version"
      ],
      "properties": {
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The article's `row_version` as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminListDictItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "class": {
          "type": "string",
          "description": "Which permission point writes a dictionary key (BR-TEXT-12 细则, 04 §11.2): general →\nconfig.general, fund_terms → content.fund_terms, agreement (table D, `privacy.` and\n`perm.`; table C real-name consent sheet, `real_name.consent.`, D10-204) →\ncontent.agreement.\n",
          "enum": [
            "general",
            "fund_terms",
            "agreement"
          ]
        },
        "key_prefix": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminSaveDictItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "changes",
        "expected_version"
      ],
      "properties": {
        "changes": {
          "type": "array",
          "description": "Keys of one class, each at most once.",
          "minItems": 1,
          "maxItems": 200,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "key",
              "text"
            ],
            "properties": {
              "key": {
                "type": "string",
                "description": "A key of contracts/texts.default.json or contracts/texts.admin.default.json.",
                "minLength": 1,
                "maxLength": 128
              },
              "text": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "The override text; null = back to the bundled default.",
                "minLength": 1,
                "maxLength": 2000
              }
            }
          }
        },
        "expected_version": {
          "type": "string",
          "description": "A dictionary version (dict_version, an integer as a string; \"0\" before the first publish).",
          "minLength": 1,
          "maxLength": 32
        },
        "legal_confirmed_by": {
          "type": "string",
          "description": "Who in legal confirmed the change; required when the keys are of class agreement (04 §11.2 content.agreement).",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "adminListDictItemVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminRollbackDictItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "keys",
        "to_version",
        "expected_version"
      ],
      "properties": {
        "keys": {
          "type": "array",
          "description": "Keys of one class, each at most once.",
          "minItems": 1,
          "maxItems": 200,
          "items": {
            "type": "string",
            "description": "A key of contracts/texts.default.json or contracts/texts.admin.default.json.",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "to_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The dictionary version to restore the keys to; lower than the current one, 0 = the bundled default."
        },
        "expected_version": {
          "type": "string",
          "description": "A dictionary version (dict_version, an integer as a string; \"0\" before the first publish).",
          "minLength": 1,
          "maxLength": 32
        },
        "legal_confirmed_by": {
          "type": "string",
          "description": "Who in legal confirmed the change; required when the keys are of class agreement (04 §11.2 content.agreement).",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "adminGetDict": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminListNotifyChannels": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminSwitchNotifyChannels": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$",
          "description": "Template code of notify_templates (04 §3, 04 §2.5 notify_template.code), e.g. WD_FAILED, SMS_CODE, DATA_COPY_CODE."
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of PATCH /admin/v1/notify-channels/{code}; at least one of push and sms.",
      "additionalProperties": false,
      "required": [
        "row_version"
      ],
      "properties": {
        "push": {
          "type": "boolean",
          "description": "Push on (true) or off (false); only when push_switchable."
        },
        "sms": {
          "type": "boolean",
          "description": "SMS on (true) or off (false); only when sms_switchable, and on only when sms_ready."
        },
        "confirm_sms_billing": {
          "type": "boolean",
          "description": "Must be true when turning SMS on for a code whose sms_billing_confirm is true; ignored otherwise."
        },
        "row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of a template code as a whole (channels and every variant's active and pending registration)."
            }
          ],
          "description": "The row_version of the item as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminRegisterNotifySms": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$",
          "description": "Template code of notify_templates (04 §3, 04 §2.5 notify_template.code), e.g. WD_FAILED, SMS_CODE, DATA_COPY_CODE."
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "variant": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
          "description": "Variant of a template code (notify_templates.variant, 04 §3); default for a code with one variant."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of PUT /admin/v1/notify-channels/{code}/sms.",
      "additionalProperties": false,
      "required": [
        "sign_name",
        "template_code",
        "template_type",
        "preview_text",
        "row_version"
      ],
      "properties": {
        "sign_name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "description": "The approved signature, without 【】."
        },
        "template_code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "description": "The approved provider template CODE."
        },
        "template_type": {
          "type": "string",
          "description": "Provider template type (enum sms_template_type); verification code or notice, marketing SMS is P1.",
          "enum": [
            "verify",
            "notice"
          ]
        },
        "preview_text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500,
          "description": "The approved template text as copied from the provider, placeholders written ${name}."
        },
        "sample": {
          "type": "object",
          "description": "Sample values for the test send, by variable name; variables not given take the server's built-in sample.",
          "maxProperties": 20,
          "additionalProperties": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        },
        "row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of a template code as a whole (channels and every variant's active and pending registration)."
            }
          ],
          "description": "The row_version of the item as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminDiscardNotifySms": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$",
          "description": "Template code of notify_templates (04 §3, 04 §2.5 notify_template.code), e.g. WD_FAILED, SMS_CODE, DATA_COPY_CODE."
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "variant": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
          "description": "Variant of a template code (notify_templates.variant, 04 §3); default for a code with one variant."
        },
        "row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "Version of a template code as a whole (channels and every variant's active and pending registration)."
        }
      },
      "required": [
        "row_version"
      ],
      "additionalProperties": false
    }
  },
  "adminRetestNotifySms": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$",
          "description": "Template code of notify_templates (04 §3, 04 §2.5 notify_template.code), e.g. WD_FAILED, SMS_CODE, DATA_COPY_CODE."
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "variant": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
          "description": "Variant of a template code (notify_templates.variant, 04 §3); default for a code with one variant."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/notify-channels/{code}/sms/pending/test.",
      "additionalProperties": false,
      "required": [
        "row_version"
      ],
      "properties": {
        "sample": {
          "type": "object",
          "description": "Sample values for the test send, by variable name; variables not given take the server's built-in sample.",
          "maxProperties": 20,
          "additionalProperties": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        },
        "row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of a template code as a whole (channels and every variant's active and pending registration)."
            }
          ],
          "description": "The row_version of the item as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminEnableNotifySms": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$",
          "description": "Template code of notify_templates (04 §3, 04 §2.5 notify_template.code), e.g. WD_FAILED, SMS_CODE, DATA_COPY_CODE."
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "variant": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
          "description": "Variant of a template code (notify_templates.variant, 04 §3); default for a code with one variant."
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/notify-channels/{code}/sms/pending/enable.",
      "additionalProperties": false,
      "required": [
        "row_version"
      ],
      "properties": {
        "row_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of a template code as a whole (channels and every variant's active and pending registration)."
            }
          ],
          "description": "The row_version of the item as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminListAppVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    }
  },
  "adminGetAppVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        }
      },
      "required": [
        "platform",
        "channel"
      ],
      "additionalProperties": false
    }
  },
  "adminSaveAppVersion": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "description": "Client platforms whose version row the console saves (a subset of ClientPlatformCode; h5 and admin rows are read-only).",
          "enum": [
            "ios",
            "android",
            "harmony"
          ]
        },
        "channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        }
      },
      "required": [
        "platform",
        "channel"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "latest_version",
        "min_supported_version",
        "recommended_version",
        "update_title",
        "update_notes",
        "store_url",
        "default_store",
        "store_listings",
        "confirmed_stores",
        "expected_row_version"
      ],
      "properties": {
        "latest_version": {
          "type": "string",
          "description": "Semantic version x.y.z.",
          "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
        },
        "min_supported_version": {
          "anyOf": [
            {
              "type": "string",
              "description": "Semantic version x.y.z.",
              "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
            },
            {
              "type": "null"
            }
          ],
          "description": "Null = no minimum. Saving a higher one than before (none before counts) needs the totp tier."
        },
        "recommended_version": {
          "anyOf": [
            {
              "type": "string",
              "description": "Semantic version x.y.z.",
              "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
            },
            {
              "type": "null"
            }
          ]
        },
        "update_title": {
          "type": "string",
          "maxLength": 100
        },
        "update_notes": {
          "type": "string",
          "maxLength": 2000
        },
        "store_url": {
          "type": "string",
          "format": "uri"
        },
        "default_store": {
          "type": "string",
          "pattern": "^[a-z0-9_]{1,32}$",
          "description": "Store key of store_url (specs/app-stores.yaml)."
        },
        "store_listings": {
          "type": "array",
          "description": "In the order the console shows; a store repeated is 20001 with data.fields=[store_listings].",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "store",
              "listed_version"
            ],
            "properties": {
              "store": {
                "type": "string",
                "minLength": 1,
                "description": "Store key of specs/app-stores.yaml (that file comes with CT-19b)."
              },
              "listed_version": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Semantic version x.y.z.",
                    "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            }
          }
        },
        "confirmed_stores": {
          "type": "array",
          "description": "Stores whose listed_version is below min_supported_version that the operator confirmed one by one (BR-ID-01 细则); may be empty.",
          "items": {
            "type": "string",
            "pattern": "^[a-z0-9_]{1,32}$"
          }
        },
        "expected_row_version": {
          "anyOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ],
          "description": "The row's row_version as the console showed it, null when there is no row yet; a mismatch is 20902."
        }
      }
    }
  },
  "adminListAppeals": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "status": {
          "type": "string",
          "description": "contracts/enums/identity.yaml appeal_status (BR-ID-36).",
          "enum": [
            "processing",
            "upheld",
            "revoked"
          ]
        },
        "overdue": {
          "type": "boolean"
        },
        "target_type": {
          "type": "string",
          "description": "contracts/enums/identity.yaml appeal_target_type, the full set (04 §3.2 appeals): the\nconsole lists and registers blocked_request appeals too, unlike the user-side\nAppealTargetType.\n",
          "enum": [
            "account",
            "order",
            "blocked_request"
          ]
        },
        "q": {
          "type": "string"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminRegisterAppeal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "target_type",
        "target_id",
        "content",
        "reason"
      ],
      "properties": {
        "target_type": {
          "type": "string",
          "description": "contracts/enums/identity.yaml appeal_target_type, the full set (04 §3.2 appeals): the\nconsole lists and registers blocked_request appeals too, unlike the user-side\nAppealTargetType.\n",
          "enum": [
            "account",
            "order",
            "blocked_request"
          ]
        },
        "target_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "The person's own statement (用户陈述)."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The registration note (登记原因说明); audit log only, 1–200 characters after trimming."
        },
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      }
    }
  },
  "adminGetAppeal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "appeal_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "appeal_id"
      ],
      "additionalProperties": false
    }
  },
  "adminClaimAppeal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "appeal_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "appeal_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_row_version"
      ],
      "properties": {
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The appeal's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminResolveAppeal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "appeal_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "appeal_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "decision",
        "note",
        "expected_row_version"
      ],
      "properties": {
        "decision": {
          "type": "string",
          "description": "How an appeal is closed (a subset of enum appeal_status; BR-ID-36).",
          "enum": [
            "upheld",
            "revoked"
          ]
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "The internal note (结案内部说明); audit log only, 1–200 characters after trimming."
        },
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "The appeal's row_version as the console showed it; a mismatch is 20902."
        }
      }
    }
  },
  "adminListBlockedRequests": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "phone": {
          "type": "string",
          "description": "Phone number as typed or pasted; it may carry spaces, hyphens and +86 / 0086 / 86. The\nserver normalises it (BR-ID-05 细则「手机号规范化」); a result that is not a mainland mobile\nnumber is 20001 with `data.fields=[phone]` and `data.reason=phone_invalid` (an empty\nstring included). No length bound in the schema: any spacing of a valid number must reach\nthe normaliser, and adding a bound to a request property is a breaking change (oasdiff).\n"
        },
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "blocked_request_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "listAdminPayOrders": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "status": {
          "type": "string",
          "description": "Pay order status (contracts/enums/pay.yaml pay_order_status; BR-PAY-02); PAID and CLOSED are final.",
          "enum": [
            "PENDING",
            "PAID",
            "CLOSED"
          ]
        },
        "pay_channel": {
          "type": "string",
          "description": "Pay channel (contracts/enums/pay.yaml pay_channel; BR-PAY-01); not the payout channel.",
          "enum": [
            "wechat_pay",
            "alipay"
          ]
        },
        "biz_type": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "out_trade_no": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "needs_manual": {
          "type": "boolean"
        },
        "created_from": {
          "type": "string",
          "format": "date-time"
        },
        "created_to": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getAdminPayOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pay_order_id"
      ],
      "additionalProperties": false
    }
  },
  "resolveAdminPayOrder": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pay_order_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/pay-orders/{pay_order_id}/resolve: fixed values only. The server\nqueries the channel itself; the console sends no status, channel result or evidence.\n",
      "additionalProperties": false,
      "required": [
        "expected_status",
        "action"
      ],
      "properties": {
        "expected_status": {
          "type": "string",
          "description": "CAS on the pay order status; only PENDING (subset of pay_order_status).",
          "enum": [
            "PENDING"
          ]
        },
        "action": {
          "type": "string",
          "description": "Query the channel now and settle by its answer (BR-PAY-05 ③).",
          "enum": [
            "query_and_settle"
          ]
        }
      }
    }
  },
  "createAdminPayRefund": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_order_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pay_order_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of the two original-route refund operations. The target comes from the path; the\nchannel, refund number, operator and status are set by the server.\n",
      "additionalProperties": false,
      "required": [
        "amount_fen",
        "reason_code"
      ],
      "properties": {
        "amount_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 1,
          "description": "Positive integer fen; with the successful and processing refunds at most the refundable amount (else 20001)."
        },
        "reason_code": {
          "type": "string",
          "description": "Refund reason code (contracts/enums/pay.yaml pay_refund_reason; BR-PAY-06); names from admin_dict.pay_refund_reason.",
          "enum": [
            "USER_REQUEST",
            "DUPLICATE_PAYMENT",
            "ANOMALY_RECEIPT",
            "RECON_DIFF",
            "OTHER"
          ]
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free text kept with the refund and in the audit record."
        }
      }
    }
  },
  "listAdminPayRefunds": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "status": {
          "type": "string",
          "description": "Refund status (contracts/enums/pay.yaml pay_refund_status; BR-PAY-06 ①).",
          "enum": [
            "PROCESSING",
            "SUCCESS",
            "FAILED"
          ]
        },
        "target_type": {
          "type": "string",
          "description": "What a refund pays back (contracts/enums/pay.yaml pay_refund_target_type; BR-PAY-06 ①).",
          "enum": [
            "pay_order",
            "pay_anomaly"
          ]
        },
        "reason_code": {
          "type": "string",
          "description": "Refund reason code (contracts/enums/pay.yaml pay_refund_reason; BR-PAY-06); names from admin_dict.pay_refund_reason.",
          "enum": [
            "USER_REQUEST",
            "DUPLICATE_PAYMENT",
            "ANOMALY_RECEIPT",
            "RECON_DIFF",
            "OTHER"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getAdminPayRefund": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_refund_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pay_refund_id"
      ],
      "additionalProperties": false
    }
  },
  "listAdminPayAnomalies": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "pay_channel": {
          "type": "string",
          "description": "Pay channel (contracts/enums/pay.yaml pay_channel; BR-PAY-01); not the payout channel.",
          "enum": [
            "wechat_pay",
            "alipay"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "createAdminPayAnomalyRefund": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "pay_anomaly_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "pay_anomaly_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of the two original-route refund operations. The target comes from the path; the\nchannel, refund number, operator and status are set by the server.\n",
      "additionalProperties": false,
      "required": [
        "amount_fen",
        "reason_code"
      ],
      "properties": {
        "amount_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 1,
          "description": "Positive integer fen; with the successful and processing refunds at most the refundable amount (else 20001)."
        },
        "reason_code": {
          "type": "string",
          "description": "Refund reason code (contracts/enums/pay.yaml pay_refund_reason; BR-PAY-06); names from admin_dict.pay_refund_reason.",
          "enum": [
            "USER_REQUEST",
            "DUPLICATE_PAYMENT",
            "ANOMALY_RECEIPT",
            "RECON_DIFF",
            "OTHER"
          ]
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free text kept with the refund and in the audit record."
        }
      }
    }
  },
  "listAdminPayReconDiffs": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "type": {
          "type": "string",
          "description": "The R4 types of contracts/enums/fund.yaml recon_diff_type (BR-PAY-07); the other types belong to R1–R3.",
          "enum": [
            "pay_mismatch",
            "pay_anomaly"
          ]
        },
        "status": {
          "type": "string",
          "description": "Reconciliation difference status (contracts/enums/fund.yaml recon_diff_status).",
          "enum": [
            "open",
            "processing",
            "adjusted",
            "written_off",
            "closed"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "listAdminReconDiffs": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "type": {
          "type": "string",
          "description": "The R1–R3 types of contracts/enums/fund.yaml recon_diff_type (BR-FUND-01, BR-FUND-04, BR-FUND-19, BR-FUND-22, BR-FUND-23); the R4 types pay_mismatch and pay_anomaly are AdminPayReconDiffType.",
          "enum": [
            "union_mismatch",
            "channel_mismatch",
            "ledger_mismatch",
            "platform_restore",
            "month_end_unbalanced",
            "settle_amount_mismatch",
            "settle_missing",
            "appeal_restore",
            "estimate_changed_after_credit"
          ]
        },
        "source": {
          "type": "string",
          "description": "Source of a difference listed under /admin/v1/recon-diffs (recon_diffs.source without R4) — R1 联盟对账, R2 通道对账, R3 内部日终与月末核对.",
          "enum": [
            "R1",
            "R2",
            "R3"
          ]
        },
        "status": {
          "type": "string",
          "description": "Reconciliation difference status (contracts/enums/fund.yaml recon_diff_status).",
          "enum": [
            "open",
            "processing",
            "adjusted",
            "written_off",
            "closed"
          ]
        },
        "period_from": {
          "type": "string",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$",
          "description": "A reconciliation period, a month (YYYY-MM) or a day (YYYY-MM-DD), as recon_diffs.period."
        },
        "period_to": {
          "type": "string",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$",
          "description": "A reconciliation period, a month (YYYY-MM) or a day (YYYY-MM-DD), as recon_diffs.period."
        },
        "ref_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getAdminReconDiff": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "recon_diff_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "recon_diff_id"
      ],
      "additionalProperties": false
    }
  },
  "closeAdminReconDiff": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "recon_diff_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "recon_diff_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/recon-diffs/{recon_diff_id}/close.",
      "additionalProperties": false,
      "required": [
        "reason"
      ],
      "properties": {
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Why the difference is closed without further handling; 1–200 characters after trimming, else 20001 with data.fields=[reason]. Stored as resolution.reason."
        },
        "outcome": {
          "description": "Optional structured conclusion, for type=settle_amount_mismatch (source R1) only; any other type or source → 20001 with data.fields=[outcome] from B2-09h on. Stored as resolution.outcome from B2-09h on; do not send it before then.",
          "type": "string",
          "enum": [
            "union",
            "ours"
          ]
        }
      }
    }
  },
  "writeOffAdminReconDiff": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "recon_diff_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "recon_diff_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/recon-diffs/{recon_diff_id}/write-off. The console confirms the\nwithdrawal status it showed and may leave a note; the evidence is the bill line stored with\nthe difference, never sent by the console.\n",
      "additionalProperties": false,
      "required": [
        "expected_withdrawal_status"
      ],
      "properties": {
        "expected_withdrawal_status": {
          "type": "string",
          "description": "Compare-and-set on the withdrawal status; only APPROVED (subset of withdrawal_status), else 20902 with data.resource=withdrawal.",
          "enum": [
            "APPROVED"
          ]
        },
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional operator note, 1–200 characters after trimming (else 20001 with data.fields=[note]); recorded under resolution.note."
        }
      }
    }
  },
  "restoreAdminReconDiff": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "recon_diff_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "recon_diff_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/recon-diffs/{recon_diff_id}/restore. The console sends no amount:\nthe amount is calculated by the server (BR-FUND-22 ③); `expected_fen` is for display only.\n",
      "additionalProperties": false,
      "properties": {
        "note": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional operator note, 1–200 characters after trimming (else 20001 with data.fields=[note]); recorded under resolution.note."
        }
      }
    }
  },
  "listAdminWithdrawals": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "status": {
          "type": "string",
          "description": "contracts/enums/fund.yaml withdrawal_status (BR-WDR-08; user texts BR-TEXT-06).",
          "enum": [
            "PENDING_REVIEW",
            "APPROVED",
            "REJECTED",
            "PAYING",
            "PAID_API",
            "PAID_MANUAL",
            "FAILED"
          ]
        },
        "display_status": {
          "type": "string",
          "description": "contracts/enums/admin.yaml admin_withdrawal_display_status: the console's display status\nof a withdrawal, derived by the server from status + review_mode + hold_reason as the\nBR-WDR-08 细则 table (花卷云「会员提现管理」mapping); not stored and not a withdrawal status.\npending_review = PENDING_REVIEW, or APPROVED with hold_reason other than\npayer_side_after_transfer; pending_handle = APPROVED with hold_reason\npayer_side_after_transfer; rejected = REJECTED; paid_manual = PAID_MANUAL;\npaid_auto_system = PAID_API with review_mode auto; paid_auto_review = PAID_API otherwise;\npaying = PAYING (needs_manual included); failed = FAILED. Chinese names from BR-TEXT-25\nadmin_dict.\n",
          "enum": [
            "pending_review",
            "pending_handle",
            "rejected",
            "paid_manual",
            "paid_auto_system",
            "paid_auto_review",
            "paying",
            "failed"
          ]
        },
        "review_mode": {
          "type": "string",
          "description": "contracts/enums/fund.yaml withdrawal_review_mode (BR-WDR-30).",
          "enum": [
            "auto",
            "manual"
          ]
        },
        "payout_channel": {
          "type": "string",
          "description": "Payout channel (enum payout_method; the <channel> of payout.channel_paused.<channel>).",
          "enum": [
            "alipay",
            "bank_card",
            "wechat"
          ]
        },
        "user_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        },
        "out_biz_no": {
          "type": "string",
          "pattern": "^[A-Za-z0-9]{1,32}$",
          "description": "The withdrawal number (withdrawals.out_biz_no, BR-WDR-07), 1–32 letters or digits."
        },
        "amount_min_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 0
        },
        "amount_max_fen": {
          "type": "integer",
          "format": "int64",
          "minimum": 0
        },
        "created_from": {
          "type": "string",
          "format": "date-time"
        },
        "created_to": {
          "type": "string",
          "format": "date-time"
        },
        "hold_reason": {
          "type": "string",
          "description": "contracts/enums/fund.yaml withdrawal_hold_reason (withdrawals.hold_reason, BR-WDR-13, BR-WDR-17).",
          "enum": [
            "payout_disabled",
            "queue_paused",
            "channel_disabled",
            "member_blocked",
            "single_cap",
            "daily_cap",
            "payer_side_after_transfer"
          ]
        },
        "blocked": {
          "type": "boolean"
        },
        "risk_flag": {
          "type": "string",
          "description": "A code of the withdrawals.risk_flags snapshot (04 §3.2): the labels ①–⑩ of BR-WDR-29 and\nrisk_calc_failed. Chinese names from BR-TEXT-25 admin_dict.withdrawals.risk_flags.\n",
          "enum": [
            "first_withdrawal",
            "credited_today",
            "same_device_multi_account",
            "invalid_ratio_60d",
            "high_commission_ratio_60d",
            "withdraw_vs_received",
            "had_negative",
            "recon_diff",
            "blacklist_hit",
            "payee_prev_other_user",
            "risk_calc_failed"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getAdminWithdrawal": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "withdrawal_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "withdrawal_id"
      ],
      "additionalProperties": false
    }
  },
  "listAdminSettleBills": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "bill_from": {
          "type": "string",
          "description": "A bill month (settle_bills.bill_id, YYYY-MM; BR-FUND-04 ③).",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
        },
        "bill_to": {
          "type": "string",
          "description": "A bill month (settle_bills.bill_id, YYYY-MM; BR-FUND-04 ③).",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
        },
        "status": {
          "type": "string",
          "description": "contracts/enums/admin.yaml admin_settle_bill_status: the console status of a monthly\nsettlement bill (BR-FUND-04 细则「月结账单状态」), derived by the server at read time and\nnot stored (settle_bills has no status column). It is derived from the batches of the\nbill's latest round, read from settle_batches: the first round is every batch of the bill\nwith kind main (generated by the bill-day task); each supplement launch is one round, the\nbatches with kind supplement sharing the same (platform, created_at) (one launch inserts\nall its batches in one transaction, so they share the column-default created_at). A\nround's time is the largest created_at of its batches; the latest round is the one with\nthe largest round time (on a tie, the round holding the largest batch_id). Batches\nrejected (CANCELLED) do not take part. In this order, the first rule that holds wins\n(now = the server clock):\ngenerating = generated_at is null (the bill-day task is still checking and generating);\nissued = the round has no batch left that is not CANCELLED (no candidate, a platform\nwith credit.enabled off keeping only its check results, or every batch of the round\nrejected), or any batch of the round is DRAFT;\nsettled = every batch of the round is DONE;\nsettling = some batch of the round is EXECUTING or PARTIAL, or CONFIRMED with settle_mode\nIMMEDIATE or with scheduled_at not later than now (due, not started yet);\nscheduled = otherwise (the batches not yet DONE are all CONFIRMED with scheduled_at later\nthan now). Chinese names from BR-TEXT-25 admin_dict.\nOnly the latest round counts, so a batch that is DRAFT outside it (a schedule cancelled\nafter a later supplement launch) does not make the bill issued: the status can be, for\nexample, settled while that batch waits for confirmation (编排裁定 D10-444). Which batches\nwait for confirmation is read from the batches with status DRAFT, not from this status.\n",
          "enum": [
            "generating",
            "issued",
            "scheduled",
            "settling",
            "settled"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "getAdminSettleBill": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "bill_id": {
          "type": "string",
          "description": "A bill month (settle_bills.bill_id, YYYY-MM; BR-FUND-04 ③).",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
        }
      },
      "required": [
        "bill_id"
      ],
      "additionalProperties": false
    }
  },
  "confirmAdminSettleBill": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "bill_id": {
          "type": "string",
          "description": "A bill month (settle_bills.bill_id, YYYY-MM; BR-FUND-04 ③).",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
        }
      },
      "required": [
        "bill_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/settle-bills/{bill_id}/confirm. `expected_batches` must match all\nthe DRAFT batches of the bill one to one, whatever their round and platform (BR-FUND-04 ⑥,\n编排裁定 D10-444), never a choice among them; any other set is 20902 with\ndata.resource=settle_batch.\n",
      "additionalProperties": false,
      "required": [
        "expected_batches"
      ],
      "properties": {
        "expected_batches": {
          "type": "array",
          "maxItems": 1000,
          "items": {
            "type": "object",
            "description": "One DRAFT batch of the bill as the console read it.",
            "additionalProperties": false,
            "required": [
              "batch_id",
              "expected_row_version"
            ],
            "properties": {
              "batch_id": {
                "type": "string",
                "description": "Entity id, a UUIDv7 string (04 §5).",
                "minLength": 1,
                "maxLength": 64
              },
              "expected_row_version": {
                "type": "integer",
                "format": "int32",
                "minimum": 0,
                "description": "settle_batches.row_version, the compare-and-set version of a batch; each batch command adds one."
              }
            }
          }
        },
        "settle_mode": {
          "allOf": [
            {
              "type": "string",
              "description": "contracts/enums/fund.yaml settle_mode (BR-FUND-04).",
              "enum": [
                "IMMEDIATE",
                "SCHEDULED"
              ]
            }
          ],
          "default": "IMMEDIATE",
          "description": "IMMEDIATE when absent."
        },
        "scheduled_at": {
          "type": "string",
          "format": "date-time",
          "description": "Required with SCHEDULED, not allowed with IMMEDIATE; later than the moment of confirmation and outside the nominal asset snapshot window (BR-FUND-04 ⑥, BR-FUND-18), else 20001 with data.fields=[scheduled_at]."
        }
      }
    }
  },
  "createAdminSettleSupplementBatches": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        },
        "idempotency-key": {
          "type": "string",
          "description": "Value of the Idempotency-Key header (04 §5「幂等」).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": [
        "idempotency-key"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "bill_id": {
          "type": "string",
          "description": "A bill month (settle_bills.bill_id, YYYY-MM; BR-FUND-04 ③).",
          "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])$"
        }
      },
      "required": [
        "bill_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/settle-bills/{bill_id}/supplement-batches.",
      "additionalProperties": false,
      "required": [
        "platform"
      ],
      "properties": {
        "platform": {
          "type": "string",
          "description": "Platform (contracts/enums/platform.yaml platform).",
          "enum": [
            "taobao",
            "jd",
            "pdd",
            "meituan",
            "vip",
            "douyin",
            "eleme",
            "kuaishou",
            "suning"
          ]
        }
      }
    }
  },
  "listAdminSettleBatchItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "batch_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "batch_id"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "item_type": {
          "type": "string",
          "description": "contracts/enums/fund.yaml settle_batch_item_type — order = sub-order row, beneficiary = beneficiary make-up item (BR-FUND-04 ⑫).",
          "enum": [
            "order",
            "beneficiary"
          ]
        },
        "result": {
          "type": "string",
          "description": "The `result` filter of the batch items — a settle_batch_item_result value, or pending = not executed yet (result null). pending is a filter value only, never a result.",
          "enum": [
            "credited",
            "skipped",
            "deferred",
            "pending"
          ]
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "cancelAdminSettleBatchSchedule": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "batch_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "batch_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/settle-batches/{batch_id}/cancel-schedule and /resume.",
      "additionalProperties": false,
      "required": [
        "expected_row_version"
      ],
      "properties": {
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "settle_batches.row_version, the compare-and-set version of a batch; each batch command adds one."
        }
      }
    }
  },
  "rejectAdminSettleBatch": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "batch_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "batch_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/settle-batches/{batch_id}/reject.",
      "additionalProperties": false,
      "required": [
        "expected_row_version",
        "reason"
      ],
      "properties": {
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "settle_batches.row_version, the compare-and-set version of a batch; each batch command adds one."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Why the batch is rejected; 1–200 characters after trimming, else 20001 with data.fields=[reason]. Stored as cancelled_reason."
        }
      }
    }
  },
  "resumeAdminSettleBatch": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "batch_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "batch_id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "description": "Body of POST /admin/v1/settle-batches/{batch_id}/cancel-schedule and /resume.",
      "additionalProperties": false,
      "required": [
        "expected_row_version"
      ],
      "properties": {
        "expected_row_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 0,
          "description": "settle_batches.row_version, the compare-and-set version of a batch; each batch command adds one."
        }
      }
    }
  },
  "listAdminAssetSnapshots": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        },
        "date_from": {
          "type": "string",
          "format": "date"
        },
        "date_to": {
          "type": "string",
          "format": "date"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminListKillSwitches": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminUpdateKillSwitch": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "value",
        "expected_version"
      ],
      "properties": {
        "value": {
          "description": "Any JSON value of the key's `value_type` (an `enum` value is one of `options`); checked by\nthe server against the key's registered type and rule, a mismatch → 20001 with\ndata.fields=[value].\n"
        },
        "expected_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
            }
          ],
          "description": "The switch's `version` as the console showed it; a mismatch is 20902."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  },
  "adminListConfigItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminBatchUpdateConfigItems": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "items"
      ],
      "properties": {
        "items": {
          "type": "array",
          "description": "Keys of one permission point, each at most once.",
          "minItems": 1,
          "maxItems": 200,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "key",
              "value",
              "expected_version"
            ],
            "properties": {
              "key": {
                "type": "string",
                "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
              },
              "value": {
                "description": "Any JSON value of the key's `value_type` (an `enum` value is one of `options`); checked by\nthe server against the key's registered type and rule, a mismatch → 20001 with\ndata.fields=[value].\n"
              },
              "expected_version": {
                "allOf": [
                  {
                    "type": "integer",
                    "format": "int32",
                    "minimum": 0,
                    "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
                  }
                ],
                "description": "The item's `version` as the console showed it; any mismatch is 20902 for the whole batch."
              }
            }
          }
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  },
  "adminGetConfigItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    }
  },
  "adminUpdateConfigItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "value",
        "expected_version"
      ],
      "properties": {
        "value": {
          "description": "Any JSON value of the key's `value_type` (an `enum` value is one of `options`); checked by\nthe server against the key's registered type and rule, a mismatch → 20001 with\ndata.fields=[value].\n"
        },
        "expected_version": {
          "allOf": [
            {
              "type": "integer",
              "format": "int32",
              "minimum": 0,
              "description": "Version of the key's current value: 0 = never written (value null, the default applies);\nplus 1 on every change or rollback, never going back. The CAS value `expected_version`\nof the writes.\n"
            }
          ],
          "description": "The item's `version` as the console showed it; a mismatch is 20902."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  },
  "adminListConfigItemVersions": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "querystring": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "maximum": 200,
          "default": 20
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  "adminRollbackConfigItem": {
    "headers": {
      "type": "object",
      "properties": {
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-step-up-token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "required": []
    },
    "params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "description": "A configuration or emergency-switch key (04 §10, §10.2): dotted segments, concrete per\nplatform or channel (`convert.enabled.taobao`); the server's registry decides which keys\nexist.\n",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_]+)*$"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "to_version",
        "expected_version"
      ],
      "properties": {
        "to_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The stored version whose value becomes the new current value; must be older than the current one."
        },
        "expected_version": {
          "type": "integer",
          "format": "int32",
          "minimum": 1,
          "description": "The item's current `version` as the console showed it; a mismatch is 20902."
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional free-text reason, kept in the audit record and the history version."
        }
      }
    }
  },
  "createAgentSession": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "getCurrentAgentSession": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    }
  },
  "sendAgentMessage": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    },
    "body": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "client_msg_id",
        "text"
      ],
      "properties": {
        "client_msg_id": {
          "type": "string",
          "description": "Generated by the client, unique in the session; a repeat returns the original run (BR-AI-23 ⑥).",
          "minLength": 8,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "description": "The message. Its length limit is step ⑤ of BR-AI-23 (20001, data.fields=[text]), checked\nafter ①–④, so the schema sets no maxLength.\n"
        },
        "context": {
          "description": "Entry context of 01 §4 情境入口, exactly one of product_key, order_id or text.",
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "product_key"
              ],
              "properties": {
                "product_key": {
                  "type": "string",
                  "description": "`<key_prefix>:<stable_id>`, at most 128 characters, opaque to clients (BR-PROD-02).\n",
                  "minLength": 3,
                  "maxLength": 128
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "order_id"
              ],
              "properties": {
                "order_id": {
                  "type": "string",
                  "description": "Entity id, a UUIDv7 string (04 §5).",
                  "minLength": 1,
                  "maxLength": 64
                }
              }
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "text"
              ],
              "properties": {
                "text": {
                  "type": "string",
                  "description": "Clipboard text, untrusted (BR-AI-05).",
                  "minLength": 1,
                  "maxLength": 2000
                }
              }
            }
          ]
        }
      }
    }
  },
  "cancelAgentRun": {
    "headers": {
      "type": "object",
      "properties": {
        "x-app-id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32,
          "pattern": "^[a-z0-9_]+$"
        },
        "x-platform": {
          "type": "string",
          "description": "Client platform (contracts/enums/platform.yaml client_platform).",
          "enum": [
            "ios",
            "android",
            "harmony",
            "h5",
            "admin"
          ]
        },
        "x-app-version": {
          "type": "string",
          "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$",
          "maxLength": 32
        },
        "x-build": {
          "type": "string",
          "maxLength": 32
        },
        "x-channel": {
          "type": "string",
          "description": "Install channel (contracts/enums/platform.yaml install_channel).",
          "enum": [
            "appstore",
            "official",
            "huawei",
            "agc"
          ]
        },
        "x-trace-id": {
          "type": "string",
          "description": "Echo of a well-formed X-Trace-Id request header, otherwise a generated UUID.",
          "minLength": 1,
          "maxLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$"
        },
        "x-device-id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "x-app-id",
        "x-platform",
        "x-app-version",
        "x-device-id"
      ]
    },
    "params": {
      "type": "object",
      "properties": {
        "run_id": {
          "type": "string",
          "description": "Entity id, a UUIDv7 string (04 §5).",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "required": [
        "run_id"
      ],
      "additionalProperties": false
    }
  }
} as const;
