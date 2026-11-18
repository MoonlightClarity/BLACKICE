// Current shared plan editor vocabulary. Independent of native model tool catalogs.
export const PLAN_EDIT_DEFINITIONS = {
  "planExpression": {
    "anyOf": [
      {
        "type": "boolean"
      },
      {
        "type": "object",
        "properties": {
          "fact": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
          }
        },
        "required": [
          "fact"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "and": {
            "type": "array",
            "minItems": 1,
            "maxItems": 512,
            "items": {
              "$ref": "#/$defs/planExpression"
            }
          }
        },
        "required": [
          "and"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "or": {
            "type": "array",
            "minItems": 1,
            "maxItems": 512,
            "items": {
              "$ref": "#/$defs/planExpression"
            }
          }
        },
        "required": [
          "or"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "not": {
            "$ref": "#/$defs/planExpression"
          }
        },
        "required": [
          "not"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "xor": {
            "type": "array",
            "minItems": 1,
            "maxItems": 512,
            "items": {
              "$ref": "#/$defs/planExpression"
            }
          }
        },
        "required": [
          "xor"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "compare": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "left",
              "op",
              "right"
            ],
            "properties": {
              "left": {
                "$ref": "#/$defs/planOperand"
              },
              "op": {
                "type": "string",
                "enum": [
                  "==",
                  "!=",
                  "<",
                  "<=",
                  ">",
                  ">=",
                  "in",
                  "not in",
                  "is",
                  "is not"
                ]
              },
              "right": {
                "$ref": "#/$defs/planOperand"
              }
            }
          }
        },
        "required": [
          "compare"
        ],
        "additionalProperties": false
      }
    ]
  },
  "planOperand": {
    "anyOf": [
      {
        "type": "object",
        "properties": {
          "fact": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
          }
        },
        "required": [
          "fact"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "value": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "boolean"
              },
              {
                "type": "number"
              },
              {
                "type": "string",
                "maxLength": 2000
              },
              {
                "type": "array",
                "maxItems": 200,
                "items": {
                  "anyOf": [
                    {
                      "type": "null"
                    },
                    {
                      "type": "boolean"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "string",
                      "maxLength": 2000
                    }
                  ]
                }
              }
            ]
          }
        },
        "required": [
          "value"
        ],
        "additionalProperties": false
      }
    ]
  }
};
export const PLAN_EDIT_SCHEMA = {
  "type": "array",
  "minItems": 1,
  "maxItems": 100,
  "description": "Edit: one atomic batch. add needs step and optional beforeId; update needs stepId/patch; move needs stepId/parentId/optional beforeId; remove deletes a subtree without silently deleting other dependencies; dependencies replaces one dependsOn list; choose selects a direct child (stepId null means root); metadata edits goal/layout/detail/focusStepId. Null clears optional details. All intermediate edits validate together. For add, the destination is step.parentId inside the complete step; outer parentId is for move only. beforeId must be a direct sibling in that destination parent; omit it to append. Metadata uses {type:\"metadata\",patch:{goal:\"updated goal\"}}; do not put metadata fields outside patch. revisit requires stepId and reason. To extend coverage or inspect a new target, use add with step.parentId to append a pending child, even to a done group. Group status is derived; existing completed leaves and evidence remain unchanged. Reserve revisit for earlier work that actually needs reassessment or another attempt; target the smallest affected step. Revisit a parent only when its entire subtree needs another attempt. Revisit preserves prior dated results and flags dependent work for reassessment. It never undoes or replays effects. Metadata can update observed facts or the root Boolean branch. assess_decision takes decisionId, input and optional selectedOptionId; BLACKICE computes and saves the comparable user costs. agency_checkpoint takes userAgency and saves the shared audience/disclosure/action checkpoint. Supplied result totals are never accepted.",
  "items": {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "create_contract"
          },
          "contract": {
            "type": "object",
            "properties": {
              "contractVersion": {
                "type": "integer",
                "const": 2
              },
              "goal": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4000
              },
              "criteria": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "observation",
                        "source-coverage",
                        "external-confirmation",
                        "judgment"
                      ],
                      "description": "Select the host evidence mechanism: observation counts distinct observed resources; source-coverage certifies complete delivered ranges for one exact stable source; external-confirmation counts distinct new destination-confirmed effects; judgment assesses a semantic conclusion using cited host evidence. Use judgment for sufficiency, eligibility and comparisons."
                    },
                    "label": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "description": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "accuracy": {
                      "anyOf": [
                        {
                          "type": "object",
                          "additionalProperties": false,
                          "required": [
                            "mode",
                            "tolerance",
                            "decisionThreshold",
                            "evidenceNeeded",
                            "consequence",
                            "unknownPolicy",
                            "stopWhen"
                          ],
                          "properties": {
                            "mode": {
                              "type": "string",
                              "enum": [
                                "exact",
                                "bounded_estimate",
                                "qualitative"
                              ]
                            },
                            "tolerance": {
                              "type": "string"
                            },
                            "decisionThreshold": {
                              "type": "string"
                            },
                            "evidenceNeeded": {
                              "type": "string"
                            },
                            "consequence": {
                              "type": "string"
                            },
                            "unknownPolicy": {
                              "type": "string",
                              "enum": [
                                "block",
                                "assumption",
                                "range",
                                "omit"
                              ]
                            },
                            "stopWhen": {
                              "type": "string"
                            }
                          }
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "resourceKey": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2048,
                      "description": "For source-coverage, identify one exact concrete source that produces a source version and delivered ranges; workspace: and origin: select scopes and are invalid coverage targets in new Plans. Observation and judgment may use a scope when retained host operation evidence proves membership. External confirmation names the destination resource established by observed receipts."
                    },
                    "targetCount": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 1000,
                      "description": "Defaults to 1. Count units are distinct observed resources, one completely covered concrete source, distinct new destination-confirmed effects, or one supported judgment per distinct owning work item. This does not count entities mentioned within an observation. Newly authored source-coverage criteria permit only 1."
                    },
                    "receiptBinding": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "version": {
                              "type": "integer",
                              "const": 1
                            },
                            "format": {
                              "type": "string",
                              "enum": [
                                "dom",
                                "json"
                              ]
                            },
                            "resourceKey": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2048
                            },
                            "record": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            },
                            "status": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 256
                            },
                            "destination": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 256
                            },
                            "confirmedValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "absentValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "outcomeId": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 256
                            },
                            "history": {
                              "type": "boolean"
                            },
                            "prior": {
                              "type": "object",
                              "properties": {
                                "field": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 256,
                                  "description": "Observed receipt field whose value identifies a pre-existing record."
                                },
                                "values": {
                                  "type": "array",
                                  "items": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 200
                                  },
                                  "minItems": 1,
                                  "maxItems": 20,
                                  "description": "Observed values denoting pre-existing records, which are excluded from new outcome counts. Select values by their observed meaning; do not copy the current field value automatically."
                                }
                              },
                              "required": [
                                "field",
                                "values"
                              ],
                              "additionalProperties": false,
                              "description": "Identifies pre-existing records excluded from new outcome counts. Map the observed field and values that denote that prior status."
                            },
                            "identity": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "field": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256
                                  },
                                  "formField": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256
                                  }
                                },
                                "required": [
                                  "field",
                                  "formField"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 20
                            }
                          },
                          "required": [
                            "version",
                            "format",
                            "resourceKey",
                            "record",
                            "status",
                            "confirmedValues",
                            "outcomeId",
                            "history"
                          ],
                          "additionalProperties": false,
                          "anyOf": [
                            {
                              "properties": {
                                "confirmedValues": {
                                  "minItems": 1
                                }
                              }
                            },
                            {
                              "required": [
                                "absentValues"
                              ],
                              "properties": {
                                "absentValues": {
                                  "minItems": 1
                                }
                              }
                            }
                          ]
                        },
                        {
                          "type": "object",
                          "properties": {
                            "version": {
                              "type": "integer",
                              "const": 1
                            },
                            "format": {
                              "type": "string",
                              "const": "dom-text"
                            },
                            "resourceKey": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2048
                            },
                            "record": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            },
                            "confirmedValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "absentValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "history": {
                              "type": "boolean",
                              "const": false
                            },
                            "outcomeFields": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "minItems": 1,
                              "maxItems": 20,
                              "uniqueItems": true
                            }
                          },
                          "required": [
                            "version",
                            "format",
                            "resourceKey",
                            "record",
                            "confirmedValues",
                            "history",
                            "outcomeFields"
                          ],
                          "additionalProperties": false,
                          "anyOf": [
                            {
                              "properties": {
                                "confirmedValues": {
                                  "minItems": 1
                                }
                              }
                            },
                            {
                              "required": [
                                "absentValues"
                              ],
                              "properties": {
                                "absentValues": {
                                  "minItems": 1
                                }
                              }
                            }
                          ]
                        }
                      ]
                    },
                    "receiptBindings": {
                      "type": "array",
                      "items": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "version": {
                                "type": "integer",
                                "const": 1
                              },
                              "format": {
                                "type": "string",
                                "enum": [
                                  "dom",
                                  "json"
                                ]
                              },
                              "resourceKey": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2048
                              },
                              "record": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 512
                              },
                              "status": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "destination": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "confirmedValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "absentValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "outcomeId": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "history": {
                                "type": "boolean"
                              },
                              "prior": {
                                "type": "object",
                                "properties": {
                                  "field": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "description": "Observed receipt field whose value identifies a pre-existing record."
                                  },
                                  "values": {
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 200
                                    },
                                    "minItems": 1,
                                    "maxItems": 20,
                                    "description": "Observed values denoting pre-existing records, which are excluded from new outcome counts. Select values by their observed meaning; do not copy the current field value automatically."
                                  }
                                },
                                "required": [
                                  "field",
                                  "values"
                                ],
                                "additionalProperties": false,
                                "description": "Identifies pre-existing records excluded from new outcome counts. Map the observed field and values that denote that prior status."
                              },
                              "identity": {
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "field": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 256
                                    },
                                    "formField": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 256
                                    }
                                  },
                                  "required": [
                                    "field",
                                    "formField"
                                  ],
                                  "additionalProperties": false
                                },
                                "minItems": 0,
                                "maxItems": 20
                              }
                            },
                            "required": [
                              "version",
                              "format",
                              "resourceKey",
                              "record",
                              "status",
                              "confirmedValues",
                              "outcomeId",
                              "history"
                            ],
                            "additionalProperties": false,
                            "anyOf": [
                              {
                                "properties": {
                                  "confirmedValues": {
                                    "minItems": 1
                                  }
                                }
                              },
                              {
                                "required": [
                                  "absentValues"
                                ],
                                "properties": {
                                  "absentValues": {
                                    "minItems": 1
                                  }
                                }
                              }
                            ]
                          },
                          {
                            "type": "object",
                            "properties": {
                              "version": {
                                "type": "integer",
                                "const": 1
                              },
                              "format": {
                                "type": "string",
                                "const": "dom-text"
                              },
                              "resourceKey": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2048
                              },
                              "record": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 512
                              },
                              "confirmedValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "absentValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "history": {
                                "type": "boolean",
                                "const": false
                              },
                              "outcomeFields": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 256
                                },
                                "minItems": 1,
                                "maxItems": 20,
                                "uniqueItems": true
                              }
                            },
                            "required": [
                              "version",
                              "format",
                              "resourceKey",
                              "record",
                              "confirmedValues",
                              "history",
                              "outcomeFields"
                            ],
                            "additionalProperties": false,
                            "anyOf": [
                              {
                                "properties": {
                                  "confirmedValues": {
                                    "minItems": 1
                                  }
                                }
                              },
                              {
                                "required": [
                                  "absentValues"
                                ],
                                "properties": {
                                  "absentValues": {
                                    "minItems": 1
                                  }
                                }
                              }
                            ]
                          }
                        ]
                      },
                      "minItems": 1,
                      "maxItems": 8,
                      "uniqueItems": true
                    }
                  },
                  "required": [
                    "id",
                    "kind",
                    "description"
                  ],
                  "additionalProperties": false,
                  "not": {
                    "required": [
                      "receiptBinding",
                      "receiptBindings"
                    ]
                  }
                },
                "minItems": 1,
                "maxItems": 40
              },
              "workItems": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "objective": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000
                    },
                    "owner": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "resourceKeys": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2048
                      },
                      "minItems": 1,
                      "maxItems": 32
                    },
                    "effects": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "observe",
                          "interact",
                          "commit",
                          "opaque"
                        ]
                      },
                      "minItems": 1,
                      "maxItems": 4,
                      "description": "Declare task-authorized effects needed inside this work item's listed resources. Include observe for its own verification and recovery. Include opaque when authorized browser behavior cannot be classified before dispatch; this does not expand resource access or bypass dependencies, evidence requirements or uncertain-effect protection."
                    },
                    "dependsOn": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      },
                      "minItems": 0,
                      "maxItems": 80
                    },
                    "criterionIds": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      },
                      "minItems": 1,
                      "maxItems": 40
                    },
                    "operationScopes": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "effect": {
                            "type": "string",
                            "enum": [
                              "observe",
                              "interact",
                              "commit",
                              "opaque"
                            ]
                          },
                          "resourceKeys": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2048
                            },
                            "minItems": 1,
                            "maxItems": 32
                          },
                          "confirmationCriterionId": {
                            "type": "string",
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                          }
                        },
                        "required": [
                          "effect",
                          "resourceKeys"
                        ],
                        "additionalProperties": false
                      },
                      "minItems": 1,
                      "maxItems": 64,
                      "description": "Assign each declared effect only to the listed work-item resources it needs. Each planned commit scope names the external-confirmation criterion owned by this work item. Other scopes omit confirmationCriterionId."
                    }
                  },
                  "required": [
                    "id",
                    "title",
                    "objective",
                    "owner",
                    "resourceKeys",
                    "effects",
                    "dependsOn",
                    "criterionIds"
                  ],
                  "additionalProperties": false
                },
                "minItems": 1,
                "maxItems": 80
              },
              "instructions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "text": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000
                    },
                    "handling": {
                      "type": "string",
                      "enum": [
                        "preserve",
                        "audit"
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "text",
                    "handling"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 80
              }
            },
            "required": [
              "contractVersion",
              "goal",
              "criteria",
              "workItems",
              "instructions"
            ],
            "additionalProperties": false
          },
          "userAgency": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "version",
              "audience",
              "userBenefit",
              "representation",
              "action",
              "decisionRequired",
              "decisionReason",
              "decisions",
              "chosenDecisionId"
            ],
            "properties": {
              "version": {
                "type": "number",
                "enum": [
                  1
                ]
              },
              "audience": {
                "type": "string",
                "enum": [
                  "user",
                  "counterparty",
                  "internal"
                ]
              },
              "userBenefit": {
                "type": "string",
                "maxLength": 4000
              },
              "representation": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "actualQuestion",
                  "requiredFacts",
                  "relevantClaims",
                  "privateFindings",
                  "userReport"
                ],
                "properties": {
                  "actualQuestion": {
                    "type": "string",
                    "maxLength": 4000
                  },
                  "requiredFacts": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "relevantClaims": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "privateFindings": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "userReport": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  }
                }
              },
              "action": {
                "type": "string",
                "enum": [
                  "proceed",
                  "ask",
                  "defer",
                  "investigate"
                ]
              },
              "decisionRequired": {
                "type": "boolean"
              },
              "decisionReason": {
                "type": "string",
                "maxLength": 4000
              },
              "decisions": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "input",
                    "selectedOptionId"
                  ],
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "input": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "decision",
                        "assumptions",
                        "hardConstraints",
                        "options"
                      ],
                      "properties": {
                        "decision": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "horizon": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "assumptions": {
                          "type": "array",
                          "maxItems": 32,
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2400
                          }
                        },
                        "hardConstraints": {
                          "type": "array",
                          "maxItems": 32,
                          "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "id",
                              "kind",
                              "rule",
                              "source",
                              "observedViolation",
                              "blockedOptionIds"
                            ],
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 120
                              },
                              "kind": {
                                "type": "string",
                                "enum": [
                                  "user_constraint",
                                  "required_authorization",
                                  "verified_requirement"
                                ]
                              },
                              "rule": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "source": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "observedViolation": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "blockedOptionIds": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 12,
                                "uniqueItems": true,
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 120
                                }
                              }
                            }
                          }
                        },
                        "options": {
                          "type": "array",
                          "minItems": 2,
                          "maxItems": 12,
                          "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "id",
                              "action",
                              "reversibility",
                              "outcome",
                              "risks",
                              "delayCost",
                              "interruptionCost",
                              "opportunityCost"
                            ],
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 120
                              },
                              "action": {
                                "type": "string",
                                "enum": [
                                  "proceed",
                                  "ask",
                                  "defer"
                                ]
                              },
                              "reversibility": {
                                "type": "string",
                                "enum": [
                                  "reversible",
                                  "partly_reversible",
                                  "irreversible"
                                ]
                              },
                              "outcome": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "risks": {
                                "type": "array",
                                "maxItems": 32,
                                "items": {
                                  "type": "object",
                                  "additionalProperties": false,
                                  "required": [
                                    "id",
                                    "probability",
                                    "severity",
                                    "probabilityBasis",
                                    "severityBasis"
                                  ],
                                  "properties": {
                                    "id": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 120
                                    },
                                    "probability": {
                                      "type": [
                                        "number",
                                        "null"
                                      ],
                                      "minimum": 0,
                                      "maximum": 1
                                    },
                                    "severity": {
                                      "type": [
                                        "number",
                                        "null"
                                      ],
                                      "minimum": 0,
                                      "maximum": 1000000
                                    },
                                    "probabilityRange": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "min",
                                        "max"
                                      ],
                                      "properties": {
                                        "min": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1
                                        },
                                        "max": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1
                                        }
                                      }
                                    },
                                    "severityRange": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "min",
                                        "max"
                                      ],
                                      "properties": {
                                        "min": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1000000
                                        },
                                        "max": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1000000
                                        }
                                      }
                                    },
                                    "probabilityBasis": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "kind",
                                        "rationale"
                                      ],
                                      "properties": {
                                        "kind": {
                                          "type": "string",
                                          "enum": [
                                            "assumption",
                                            "user_estimate",
                                            "empirical",
                                            "unknown"
                                          ]
                                        },
                                        "rationale": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "source": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "events": {
                                          "type": "integer",
                                          "minimum": 0,
                                          "maximum": 9007199254740991
                                        },
                                        "trials": {
                                          "type": "integer",
                                          "minimum": 1,
                                          "maximum": 9007199254740991
                                        }
                                      }
                                    },
                                    "severityBasis": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "anchor",
                                        "consequence",
                                        "conversionBasis"
                                      ],
                                      "properties": {
                                        "anchor": {
                                          "type": "string",
                                          "enum": [
                                            "none",
                                            "brief_rework",
                                            "bounded_rework",
                                            "substantial_rework",
                                            "material_setback",
                                            "major_loss",
                                            "unknown"
                                          ]
                                        },
                                        "consequence": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "conversionBasis": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        }
                                      }
                                    }
                                  }
                                }
                              },
                              "delayCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "interruptionCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "opportunityCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "clarification": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "baselineOptionId",
                                  "informationNeeded",
                                  "howAnswerChangesAction",
                                  "residualRiskBasis"
                                ],
                                "properties": {
                                  "baselineOptionId": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 120
                                  },
                                  "informationNeeded": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "howAnswerChangesAction": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "residualRiskBasis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    "selectedOptionId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  }
                }
              },
              "chosenDecisionId": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 120
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            }
          }
        },
        "required": [
          "type",
          "contract"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "replace_contract"
          },
          "contract": {
            "type": "object",
            "properties": {
              "contractVersion": {
                "type": "integer",
                "const": 2
              },
              "goal": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4000
              },
              "criteria": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "observation",
                        "source-coverage",
                        "external-confirmation",
                        "judgment"
                      ],
                      "description": "Select the host evidence mechanism: observation counts distinct observed resources; source-coverage certifies complete delivered ranges for one exact stable source; external-confirmation counts distinct new destination-confirmed effects; judgment assesses a semantic conclusion using cited host evidence. Use judgment for sufficiency, eligibility and comparisons."
                    },
                    "label": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "description": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "accuracy": {
                      "anyOf": [
                        {
                          "type": "object",
                          "additionalProperties": false,
                          "required": [
                            "mode",
                            "tolerance",
                            "decisionThreshold",
                            "evidenceNeeded",
                            "consequence",
                            "unknownPolicy",
                            "stopWhen"
                          ],
                          "properties": {
                            "mode": {
                              "type": "string",
                              "enum": [
                                "exact",
                                "bounded_estimate",
                                "qualitative"
                              ]
                            },
                            "tolerance": {
                              "type": "string"
                            },
                            "decisionThreshold": {
                              "type": "string"
                            },
                            "evidenceNeeded": {
                              "type": "string"
                            },
                            "consequence": {
                              "type": "string"
                            },
                            "unknownPolicy": {
                              "type": "string",
                              "enum": [
                                "block",
                                "assumption",
                                "range",
                                "omit"
                              ]
                            },
                            "stopWhen": {
                              "type": "string"
                            }
                          }
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "resourceKey": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2048,
                      "description": "For source-coverage, identify one exact concrete source that produces a source version and delivered ranges; workspace: and origin: select scopes and are invalid coverage targets in new Plans. Observation and judgment may use a scope when retained host operation evidence proves membership. External confirmation names the destination resource established by observed receipts."
                    },
                    "targetCount": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 1000,
                      "description": "Defaults to 1. Count units are distinct observed resources, one completely covered concrete source, distinct new destination-confirmed effects, or one supported judgment per distinct owning work item. This does not count entities mentioned within an observation. Newly authored source-coverage criteria permit only 1."
                    },
                    "receiptBinding": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "version": {
                              "type": "integer",
                              "const": 1
                            },
                            "format": {
                              "type": "string",
                              "enum": [
                                "dom",
                                "json"
                              ]
                            },
                            "resourceKey": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2048
                            },
                            "record": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            },
                            "status": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 256
                            },
                            "destination": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 256
                            },
                            "confirmedValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "absentValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "outcomeId": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 256
                            },
                            "history": {
                              "type": "boolean"
                            },
                            "prior": {
                              "type": "object",
                              "properties": {
                                "field": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 256,
                                  "description": "Observed receipt field whose value identifies a pre-existing record."
                                },
                                "values": {
                                  "type": "array",
                                  "items": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 200
                                  },
                                  "minItems": 1,
                                  "maxItems": 20,
                                  "description": "Observed values denoting pre-existing records, which are excluded from new outcome counts. Select values by their observed meaning; do not copy the current field value automatically."
                                }
                              },
                              "required": [
                                "field",
                                "values"
                              ],
                              "additionalProperties": false,
                              "description": "Identifies pre-existing records excluded from new outcome counts. Map the observed field and values that denote that prior status."
                            },
                            "identity": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "field": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256
                                  },
                                  "formField": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256
                                  }
                                },
                                "required": [
                                  "field",
                                  "formField"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 20
                            }
                          },
                          "required": [
                            "version",
                            "format",
                            "resourceKey",
                            "record",
                            "status",
                            "confirmedValues",
                            "outcomeId",
                            "history"
                          ],
                          "additionalProperties": false,
                          "anyOf": [
                            {
                              "properties": {
                                "confirmedValues": {
                                  "minItems": 1
                                }
                              }
                            },
                            {
                              "required": [
                                "absentValues"
                              ],
                              "properties": {
                                "absentValues": {
                                  "minItems": 1
                                }
                              }
                            }
                          ]
                        },
                        {
                          "type": "object",
                          "properties": {
                            "version": {
                              "type": "integer",
                              "const": 1
                            },
                            "format": {
                              "type": "string",
                              "const": "dom-text"
                            },
                            "resourceKey": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2048
                            },
                            "record": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 512
                            },
                            "confirmedValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "absentValues": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              },
                              "minItems": 0,
                              "maxItems": 20
                            },
                            "history": {
                              "type": "boolean",
                              "const": false
                            },
                            "outcomeFields": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "minItems": 1,
                              "maxItems": 20,
                              "uniqueItems": true
                            }
                          },
                          "required": [
                            "version",
                            "format",
                            "resourceKey",
                            "record",
                            "confirmedValues",
                            "history",
                            "outcomeFields"
                          ],
                          "additionalProperties": false,
                          "anyOf": [
                            {
                              "properties": {
                                "confirmedValues": {
                                  "minItems": 1
                                }
                              }
                            },
                            {
                              "required": [
                                "absentValues"
                              ],
                              "properties": {
                                "absentValues": {
                                  "minItems": 1
                                }
                              }
                            }
                          ]
                        }
                      ]
                    },
                    "receiptBindings": {
                      "type": "array",
                      "items": {
                        "anyOf": [
                          {
                            "type": "object",
                            "properties": {
                              "version": {
                                "type": "integer",
                                "const": 1
                              },
                              "format": {
                                "type": "string",
                                "enum": [
                                  "dom",
                                  "json"
                                ]
                              },
                              "resourceKey": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2048
                              },
                              "record": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 512
                              },
                              "status": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "destination": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "confirmedValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "absentValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "outcomeId": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256
                              },
                              "history": {
                                "type": "boolean"
                              },
                              "prior": {
                                "type": "object",
                                "properties": {
                                  "field": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "description": "Observed receipt field whose value identifies a pre-existing record."
                                  },
                                  "values": {
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 200
                                    },
                                    "minItems": 1,
                                    "maxItems": 20,
                                    "description": "Observed values denoting pre-existing records, which are excluded from new outcome counts. Select values by their observed meaning; do not copy the current field value automatically."
                                  }
                                },
                                "required": [
                                  "field",
                                  "values"
                                ],
                                "additionalProperties": false,
                                "description": "Identifies pre-existing records excluded from new outcome counts. Map the observed field and values that denote that prior status."
                              },
                              "identity": {
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "field": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 256
                                    },
                                    "formField": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 256
                                    }
                                  },
                                  "required": [
                                    "field",
                                    "formField"
                                  ],
                                  "additionalProperties": false
                                },
                                "minItems": 0,
                                "maxItems": 20
                              }
                            },
                            "required": [
                              "version",
                              "format",
                              "resourceKey",
                              "record",
                              "status",
                              "confirmedValues",
                              "outcomeId",
                              "history"
                            ],
                            "additionalProperties": false,
                            "anyOf": [
                              {
                                "properties": {
                                  "confirmedValues": {
                                    "minItems": 1
                                  }
                                }
                              },
                              {
                                "required": [
                                  "absentValues"
                                ],
                                "properties": {
                                  "absentValues": {
                                    "minItems": 1
                                  }
                                }
                              }
                            ]
                          },
                          {
                            "type": "object",
                            "properties": {
                              "version": {
                                "type": "integer",
                                "const": 1
                              },
                              "format": {
                                "type": "string",
                                "const": "dom-text"
                              },
                              "resourceKey": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2048
                              },
                              "record": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 512
                              },
                              "confirmedValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "absentValues": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "minItems": 0,
                                "maxItems": 20
                              },
                              "history": {
                                "type": "boolean",
                                "const": false
                              },
                              "outcomeFields": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 256
                                },
                                "minItems": 1,
                                "maxItems": 20,
                                "uniqueItems": true
                              }
                            },
                            "required": [
                              "version",
                              "format",
                              "resourceKey",
                              "record",
                              "confirmedValues",
                              "history",
                              "outcomeFields"
                            ],
                            "additionalProperties": false,
                            "anyOf": [
                              {
                                "properties": {
                                  "confirmedValues": {
                                    "minItems": 1
                                  }
                                }
                              },
                              {
                                "required": [
                                  "absentValues"
                                ],
                                "properties": {
                                  "absentValues": {
                                    "minItems": 1
                                  }
                                }
                              }
                            ]
                          }
                        ]
                      },
                      "minItems": 1,
                      "maxItems": 8,
                      "uniqueItems": true
                    }
                  },
                  "required": [
                    "id",
                    "kind",
                    "description"
                  ],
                  "additionalProperties": false,
                  "not": {
                    "required": [
                      "receiptBinding",
                      "receiptBindings"
                    ]
                  }
                },
                "minItems": 1,
                "maxItems": 40
              },
              "workItems": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "objective": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000
                    },
                    "owner": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "resourceKeys": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2048
                      },
                      "minItems": 1,
                      "maxItems": 32
                    },
                    "effects": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "observe",
                          "interact",
                          "commit",
                          "opaque"
                        ]
                      },
                      "minItems": 1,
                      "maxItems": 4,
                      "description": "Declare task-authorized effects needed inside this work item's listed resources. Include observe for its own verification and recovery. Include opaque when authorized browser behavior cannot be classified before dispatch; this does not expand resource access or bypass dependencies, evidence requirements or uncertain-effect protection."
                    },
                    "dependsOn": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      },
                      "minItems": 0,
                      "maxItems": 80
                    },
                    "criterionIds": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      },
                      "minItems": 1,
                      "maxItems": 40
                    },
                    "operationScopes": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "effect": {
                            "type": "string",
                            "enum": [
                              "observe",
                              "interact",
                              "commit",
                              "opaque"
                            ]
                          },
                          "resourceKeys": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2048
                            },
                            "minItems": 1,
                            "maxItems": 32
                          },
                          "confirmationCriterionId": {
                            "type": "string",
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                          }
                        },
                        "required": [
                          "effect",
                          "resourceKeys"
                        ],
                        "additionalProperties": false
                      },
                      "minItems": 1,
                      "maxItems": 64,
                      "description": "Assign each declared effect only to the listed work-item resources it needs. Each planned commit scope names the external-confirmation criterion owned by this work item. Other scopes omit confirmationCriterionId."
                    }
                  },
                  "required": [
                    "id",
                    "title",
                    "objective",
                    "owner",
                    "resourceKeys",
                    "effects",
                    "dependsOn",
                    "criterionIds"
                  ],
                  "additionalProperties": false
                },
                "minItems": 1,
                "maxItems": 80
              },
              "instructions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "text": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000
                    },
                    "handling": {
                      "type": "string",
                      "enum": [
                        "preserve",
                        "audit"
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "text",
                    "handling"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 80
              }
            },
            "required": [
              "contractVersion",
              "goal",
              "criteria",
              "workItems",
              "instructions"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "type",
          "contract"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "create"
          },
          "goal": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "plan": {
            "type": "object",
            "properties": {
              "layout": {
                "type": "string",
                "enum": [
                  "sequence",
                  "parallel",
                  "choice"
                ],
                "description": "Sequence gives chronological sibling order. Parallel represents independent paths; Planning On still executes one active leaf at a time. Choice uses a Boolean branch or an explicit legacy selection."
              },
              "detail": {
                "type": "string",
                "enum": [
                  "compact",
                  "balanced",
                  "detailed"
                ],
                "description": "Compact for a few actions, balanced for actionable substeps, detailed for finer decomposition. The request supplies its initial preference."
              },
              "taskType": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_-]{1,100}$"
              },
              "method": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9_-]{1,100}$"
                      },
                      "revision": {
                        "type": "integer",
                        "minimum": 1
                      }
                    },
                    "required": [
                      "id",
                      "revision"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ],
                "description": "Optional exact saved method reference; describe methodId first. Copied steps remain editable and no verification is implied. Null clears the reference."
              },
              "focusStepId": {
                "type": [
                  "string",
                  "null"
                ],
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
                "description": "The step currently worth attention; null clears a previous focus."
              },
              "selectedChildId": {
                "type": [
                  "string",
                  "null"
                ],
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
                "description": "For root choice: explicit direct child to follow. Other paths remain pending until explicitly skipped. Null clears the selection."
              },
              "decisionCriteria": {
                "anyOf": [
                  {
                    "type": "array",
                    "maxItems": 24,
                    "description": "Optional, general-purpose decision rubric. Separate verified hard gates, substantial barriers, adaptable gaps, stated requirements, preferences and unresolved facts. Do not promote external claims to hard gates merely because they are written as requirements. Older job-specific kinds remain supported.",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "id",
                        "label",
                        "kind",
                        "source",
                        "basis"
                      ],
                      "properties": {
                        "id": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                        },
                        "label": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 180
                        },
                        "kind": {
                          "type": "string",
                          "enum": [
                            "hard_gate",
                            "material_barrier",
                            "adaptable_gap",
                            "stated_requirement",
                            "preference",
                            "unverified",
                            "substantial_skill",
                            "trainable_skill",
                            "employer_wishlist"
                          ]
                        },
                        "source": {
                          "type": "string",
                          "enum": [
                            "user",
                            "external",
                            "analyst",
                            "employer"
                          ]
                        },
                        "basis": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 700
                        },
                        "priority": {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 5
                        },
                        "verifiedNonNegotiable": {
                          "type": "boolean"
                        },
                        "evidenceStatus": {
                          "type": "string",
                          "enum": [
                            "confirmed",
                            "reported",
                            "inferred",
                            "unknown",
                            "contradicted"
                          ]
                        }
                      }
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "metacognition": {
                "anyOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "description": "Optional practical judgment frame. Record only the fields that change the decision; do not fill a ritual checklist.",
                    "properties": {
                      "outcome": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "The real-world result that matters, not just an output-format proxy."
                      },
                      "keyUncertainty": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "One assumption that could materially change the outcome, distinguishing unknown from disproved."
                      },
                      "nextProbe": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "A cheap concrete check or counterexample that could falsify the current assumption."
                      },
                      "goodEnough": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "A proportional sufficient result; do not require perfection."
                      },
                      "reassessWhen": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "When to stop, seek new evidence or change approach."
                      },
                      "observation": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "Observed outcome versus expectation, with its actual limits."
                      },
                      "lesson": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "A concrete, transferable correction, not an automatic global rule."
                      }
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "facts": {
                "anyOf": [
                  {
                    "type": "array",
                    "maxItems": 200,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "id",
                        "value"
                      ],
                      "properties": {
                        "id": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                        },
                        "value": {
                          "anyOf": [
                            {
                              "type": "null"
                            },
                            {
                              "type": "boolean"
                            },
                            {
                              "type": "number"
                            },
                            {
                              "type": "string",
                              "maxLength": 2000
                            },
                            {
                              "type": "array",
                              "maxItems": 200,
                              "items": {
                                "anyOf": [
                                  {
                                    "type": "null"
                                  },
                                  {
                                    "type": "boolean"
                                  },
                                  {
                                    "type": "number"
                                  },
                                  {
                                    "type": "string",
                                    "maxLength": 2000
                                  }
                                ]
                              }
                            }
                          ]
                        },
                        "known": {
                          "type": "boolean",
                          "description": "Optional: false means unknown; true permits observed None/null. Default: non-null values are known and null is unknown."
                        },
                        "evidence": {
                          "type": "string",
                          "maxLength": 2000,
                          "description": "Actual basis for any known observation. Required and nonempty when known. Missing evidence is not a false condition."
                        }
                      }
                    },
                    "description": "Observed constituent values for binding Boolean conditions, with their actual sources. Do not present a model judgment as an observed aggregate fact; save qualitative judgments in reasoning evidence or a manual choice instead. Source-reported Boolean flags and direct binary observations remain valid facts. Keep missing evidence unknown."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "branch": {
                "anyOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "if",
                      "then",
                      "else"
                    ],
                    "properties": {
                      "if": {
                        "$ref": "#/$defs/planExpression"
                      },
                      "then": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      },
                      "elif": {
                        "type": "array",
                        "maxItems": 198,
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "required": [
                            "if",
                            "then"
                          ],
                          "properties": {
                            "if": {
                              "$ref": "#/$defs/planExpression"
                            },
                            "then": {
                              "type": "string",
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                            }
                          }
                        }
                      },
                      "else": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      }
                    },
                    "description": "Executable IF/ELIF/ELSE for an actual binding rule on a choice. Branch IDs are distinct direct children. Check IF then each ELIF in order; the first true condition selects its path, all false selects ELSE. An earlier unknown blocks fallthrough. Expressions recursively support and/or/not/xor and comparisons over observed constituent facts. Preserve the binding rule instead of substituting a model-computed readiness flag. Changed inputs reevaluate the same rule; selectedChildId is derived. A discretionary choice may omit branch and save selectedChildId with its supported judgment."
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "additionalProperties": false,
            "description": "Plan metadata only (layout, detail and optional references). Put the action array in top-level steps, never plan.steps. A plan call also requires top-level expectedRevision."
          },
          "steps": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string"
                },
                "title": {
                  "type": "string"
                },
                "status": {
                  "type": "string",
                  "enum": [
                    "pending",
                    "active",
                    "blocked",
                    "done",
                    "skipped"
                  ]
                },
                "note": {
                  "type": "string",
                  "maxLength": 700
                },
                "doneWhen": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000,
                  "description": "Observable completion check. An inquiry may finish with confirmation, refutation or a bounded unresolved finding. A failed operation does not satisfy the requested effect."
                },
                "evidence": {
                  "type": "string",
                  "maxLength": 2000,
                  "description": "Agent-reported work or check results, including limits. This is not runtime verification."
                },
                "blockedReason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000,
                  "description": "Required when blocked; describe the actual obstacle. Cleared when the milestone leaves blocked."
                },
                "parentId": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
                  "description": "Parent group ID; null or omitted means a root child. Array order determines sibling order."
                },
                "kind": {
                  "type": "string",
                  "enum": [
                    "action",
                    "sequence",
                    "parallel",
                    "choice"
                  ],
                  "description": "An action has no children. Other kinds group actions and derive their status from them."
                },
                "dependsOn": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                  },
                  "maxItems": 199,
                  "uniqueItems": true,
                  "description": "Additional prerequisites that must be done before this path starts. Sequence order is already implicit."
                },
                "stepType": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9_-]{1,100}$",
                  "description": "A saved descriptive step type from describe; it grants no tools."
                },
                "condition": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000,
                  "description": "Observable condition for this alternative; text alone never activates a branch."
                },
                "skipReason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000,
                  "description": "Required for a skipped action. Say why the work was deliberately not performed."
                },
                "result": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000,
                  "description": "Planned work product or desired operational state. For uncertain analysis, specify the answer to develop without predetermining its finding. Record the completed finding in evidence."
                },
                "artifactIds": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                  },
                  "maxItems": 20,
                  "uniqueItems": true,
                  "description": "IDs of actual deliverables already registered to this task."
                },
                "selectedChildId": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
                  "description": "For a choice group, the direct child to follow. Update unused child actions to skipped with reasons; selection alone never claims completion."
                },
                "operation": {
                  "anyOf": [
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "kind",
                        "tool",
                        "target"
                      ],
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "tool"
                        },
                        "tool": {
                          "type": "string",
                          "pattern": "^relay_[a-z_]{1,60}$"
                        },
                        "action": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 1000
                        }
                      }
                    },
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "kind",
                        "target"
                      ],
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "reasoning"
                        },
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 1000
                        }
                      }
                    }
                  ],
                  "description": "One bounded primary operation. Tool leaves name one exact attached relay tool, its action when exposed, and target; do not invent actions for actionless tools. Needed host-classified read-only observations may support it under the same active leaf. Reasoning leaves remain bounded questions without operational tool dispatch. Auxiliary observations do not replace the primary operation or become reconciliation proof."
                },
                "branch": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "if",
                    "then",
                    "else"
                  ],
                  "properties": {
                    "if": {
                      "$ref": "#/$defs/planExpression"
                    },
                    "then": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "elif": {
                      "type": "array",
                      "maxItems": 198,
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                          "if",
                          "then"
                        ],
                        "properties": {
                          "if": {
                            "$ref": "#/$defs/planExpression"
                          },
                          "then": {
                            "type": "string",
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                          }
                        }
                      }
                    },
                    "else": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    }
                  },
                  "description": "Executable IF/ELIF/ELSE for an actual binding rule on a choice. Branch IDs are distinct direct children. Check IF then each ELIF in order; the first true condition selects its path, all false selects ELSE. An earlier unknown blocks fallthrough. Expressions recursively support and/or/not/xor and comparisons over observed constituent facts. Preserve the binding rule instead of substituting a model-computed readiness flag. Changed inputs reevaluate the same rule; selectedChildId is derived. A discretionary choice may omit branch and save selectedChildId with its supported judgment."
                },
                "reconciliation": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "callId",
                    "outcome",
                    "evidence"
                  ],
                  "properties": {
                    "callId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$",
                      "description": "The task-unique callId from the original planning.sequence annotation or unresolved-dispatch receipt, not the provider session call ID."
                    },
                    "outcome": {
                      "type": "string",
                      "enum": [
                        "confirmed",
                        "absent"
                      ]
                    },
                    "evidence": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    }
                  },
                  "description": "Only on a completed observation leaf: the actual finding from a later read-only check of one interrupted call. confirmed means the effect was observed; absent means checked absent. This preserves uncertainty until checked and never replays the original effect."
                }
              },
              "required": [
                "title"
              ],
              "additionalProperties": false
            },
            "minItems": 1,
            "maxItems": 200,
            "description": "Plan: required top-level action/group array alongside expectedRevision and optional plan metadata. Every action needs doneWhen; mark done only with actual evidence. Use parentId for hierarchy, not nested steps arrays."
          },
          "userAgency": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "version",
              "audience",
              "userBenefit",
              "representation",
              "action",
              "decisionRequired",
              "decisionReason",
              "decisions",
              "chosenDecisionId"
            ],
            "properties": {
              "version": {
                "type": "number",
                "enum": [
                  1
                ]
              },
              "audience": {
                "type": "string",
                "enum": [
                  "user",
                  "counterparty",
                  "internal"
                ]
              },
              "userBenefit": {
                "type": "string",
                "maxLength": 4000
              },
              "representation": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "actualQuestion",
                  "requiredFacts",
                  "relevantClaims",
                  "privateFindings",
                  "userReport"
                ],
                "properties": {
                  "actualQuestion": {
                    "type": "string",
                    "maxLength": 4000
                  },
                  "requiredFacts": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "relevantClaims": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "privateFindings": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "userReport": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  }
                }
              },
              "action": {
                "type": "string",
                "enum": [
                  "proceed",
                  "ask",
                  "defer",
                  "investigate"
                ]
              },
              "decisionRequired": {
                "type": "boolean"
              },
              "decisionReason": {
                "type": "string",
                "maxLength": 4000
              },
              "decisions": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "input",
                    "selectedOptionId"
                  ],
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "input": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "decision",
                        "assumptions",
                        "hardConstraints",
                        "options"
                      ],
                      "properties": {
                        "decision": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "horizon": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "assumptions": {
                          "type": "array",
                          "maxItems": 32,
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2400
                          }
                        },
                        "hardConstraints": {
                          "type": "array",
                          "maxItems": 32,
                          "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "id",
                              "kind",
                              "rule",
                              "source",
                              "observedViolation",
                              "blockedOptionIds"
                            ],
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 120
                              },
                              "kind": {
                                "type": "string",
                                "enum": [
                                  "user_constraint",
                                  "required_authorization",
                                  "verified_requirement"
                                ]
                              },
                              "rule": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "source": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "observedViolation": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "blockedOptionIds": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 12,
                                "uniqueItems": true,
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 120
                                }
                              }
                            }
                          }
                        },
                        "options": {
                          "type": "array",
                          "minItems": 2,
                          "maxItems": 12,
                          "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "id",
                              "action",
                              "reversibility",
                              "outcome",
                              "risks",
                              "delayCost",
                              "interruptionCost",
                              "opportunityCost"
                            ],
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 120
                              },
                              "action": {
                                "type": "string",
                                "enum": [
                                  "proceed",
                                  "ask",
                                  "defer"
                                ]
                              },
                              "reversibility": {
                                "type": "string",
                                "enum": [
                                  "reversible",
                                  "partly_reversible",
                                  "irreversible"
                                ]
                              },
                              "outcome": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "risks": {
                                "type": "array",
                                "maxItems": 32,
                                "items": {
                                  "type": "object",
                                  "additionalProperties": false,
                                  "required": [
                                    "id",
                                    "probability",
                                    "severity",
                                    "probabilityBasis",
                                    "severityBasis"
                                  ],
                                  "properties": {
                                    "id": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 120
                                    },
                                    "probability": {
                                      "type": [
                                        "number",
                                        "null"
                                      ],
                                      "minimum": 0,
                                      "maximum": 1
                                    },
                                    "severity": {
                                      "type": [
                                        "number",
                                        "null"
                                      ],
                                      "minimum": 0,
                                      "maximum": 1000000
                                    },
                                    "probabilityRange": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "min",
                                        "max"
                                      ],
                                      "properties": {
                                        "min": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1
                                        },
                                        "max": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1
                                        }
                                      }
                                    },
                                    "severityRange": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "min",
                                        "max"
                                      ],
                                      "properties": {
                                        "min": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1000000
                                        },
                                        "max": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1000000
                                        }
                                      }
                                    },
                                    "probabilityBasis": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "kind",
                                        "rationale"
                                      ],
                                      "properties": {
                                        "kind": {
                                          "type": "string",
                                          "enum": [
                                            "assumption",
                                            "user_estimate",
                                            "empirical",
                                            "unknown"
                                          ]
                                        },
                                        "rationale": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "source": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "events": {
                                          "type": "integer",
                                          "minimum": 0,
                                          "maximum": 9007199254740991
                                        },
                                        "trials": {
                                          "type": "integer",
                                          "minimum": 1,
                                          "maximum": 9007199254740991
                                        }
                                      }
                                    },
                                    "severityBasis": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "anchor",
                                        "consequence",
                                        "conversionBasis"
                                      ],
                                      "properties": {
                                        "anchor": {
                                          "type": "string",
                                          "enum": [
                                            "none",
                                            "brief_rework",
                                            "bounded_rework",
                                            "substantial_rework",
                                            "material_setback",
                                            "major_loss",
                                            "unknown"
                                          ]
                                        },
                                        "consequence": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "conversionBasis": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        }
                                      }
                                    }
                                  }
                                }
                              },
                              "delayCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "interruptionCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "opportunityCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "clarification": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "baselineOptionId",
                                  "informationNeeded",
                                  "howAnswerChangesAction",
                                  "residualRiskBasis"
                                ],
                                "properties": {
                                  "baselineOptionId": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 120
                                  },
                                  "informationNeeded": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "howAnswerChangesAction": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "residualRiskBasis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    "selectedOptionId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  }
                }
              },
              "chosenDecisionId": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 120
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            }
          }
        },
        "required": [
          "type",
          "goal",
          "steps"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "assess_decision"
          },
          "decisionId": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
            "minLength": 1,
            "maxLength": 120
          },
          "input": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "decision",
              "assumptions",
              "hardConstraints",
              "options"
            ],
            "properties": {
              "decision": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2400
              },
              "horizon": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2400
              },
              "assumptions": {
                "type": "array",
                "maxItems": 32,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2400
                }
              },
              "hardConstraints": {
                "type": "array",
                "maxItems": 32,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "kind",
                    "rule",
                    "source",
                    "observedViolation",
                    "blockedOptionIds"
                  ],
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "user_constraint",
                        "required_authorization",
                        "verified_requirement"
                      ]
                    },
                    "rule": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2400
                    },
                    "source": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2400
                    },
                    "observedViolation": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2400
                    },
                    "blockedOptionIds": {
                      "type": "array",
                      "minItems": 1,
                      "maxItems": 12,
                      "uniqueItems": true,
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 120
                      }
                    }
                  }
                }
              },
              "options": {
                "type": "array",
                "minItems": 2,
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "action",
                    "reversibility",
                    "outcome",
                    "risks",
                    "delayCost",
                    "interruptionCost",
                    "opportunityCost"
                  ],
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "action": {
                      "type": "string",
                      "enum": [
                        "proceed",
                        "ask",
                        "defer"
                      ]
                    },
                    "reversibility": {
                      "type": "string",
                      "enum": [
                        "reversible",
                        "partly_reversible",
                        "irreversible"
                      ]
                    },
                    "outcome": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2400
                    },
                    "risks": {
                      "type": "array",
                      "maxItems": 32,
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                          "id",
                          "probability",
                          "severity",
                          "probabilityBasis",
                          "severityBasis"
                        ],
                        "properties": {
                          "id": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 120
                          },
                          "probability": {
                            "type": [
                              "number",
                              "null"
                            ],
                            "minimum": 0,
                            "maximum": 1
                          },
                          "severity": {
                            "type": [
                              "number",
                              "null"
                            ],
                            "minimum": 0,
                            "maximum": 1000000
                          },
                          "probabilityRange": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "min",
                              "max"
                            ],
                            "properties": {
                              "min": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              "max": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              }
                            }
                          },
                          "severityRange": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "min",
                              "max"
                            ],
                            "properties": {
                              "min": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1000000
                              },
                              "max": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1000000
                              }
                            }
                          },
                          "probabilityBasis": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "kind",
                              "rationale"
                            ],
                            "properties": {
                              "kind": {
                                "type": "string",
                                "enum": [
                                  "assumption",
                                  "user_estimate",
                                  "empirical",
                                  "unknown"
                                ]
                              },
                              "rationale": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "source": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "events": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 9007199254740991
                              },
                              "trials": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 9007199254740991
                              }
                            }
                          },
                          "severityBasis": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "anchor",
                              "consequence",
                              "conversionBasis"
                            ],
                            "properties": {
                              "anchor": {
                                "type": "string",
                                "enum": [
                                  "none",
                                  "brief_rework",
                                  "bounded_rework",
                                  "substantial_rework",
                                  "material_setback",
                                  "major_loss",
                                  "unknown"
                                ]
                              },
                              "consequence": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "conversionBasis": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              }
                            }
                          }
                        }
                      }
                    },
                    "delayCost": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "value",
                        "basis"
                      ],
                      "properties": {
                        "value": {
                          "type": [
                            "number",
                            "null"
                          ],
                          "minimum": 0,
                          "maximum": 1000000
                        },
                        "basis": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "zeroCostJustification": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        }
                      }
                    },
                    "interruptionCost": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "value",
                        "basis"
                      ],
                      "properties": {
                        "value": {
                          "type": [
                            "number",
                            "null"
                          ],
                          "minimum": 0,
                          "maximum": 1000000
                        },
                        "basis": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "zeroCostJustification": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        }
                      }
                    },
                    "opportunityCost": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "value",
                        "basis"
                      ],
                      "properties": {
                        "value": {
                          "type": [
                            "number",
                            "null"
                          ],
                          "minimum": 0,
                          "maximum": 1000000
                        },
                        "basis": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "zeroCostJustification": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        }
                      }
                    },
                    "clarification": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "baselineOptionId",
                        "informationNeeded",
                        "howAnswerChangesAction",
                        "residualRiskBasis"
                      ],
                      "properties": {
                        "baselineOptionId": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        "informationNeeded": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "howAnswerChangesAction": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "residualRiskBasis": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "selectedOptionId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
                "minLength": 1,
                "maxLength": 120
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "type",
          "decisionId",
          "input"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "agency_checkpoint"
          },
          "userAgency": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "version",
              "audience",
              "userBenefit",
              "representation",
              "action",
              "decisionRequired",
              "decisionReason",
              "decisions",
              "chosenDecisionId"
            ],
            "properties": {
              "version": {
                "type": "number",
                "enum": [
                  1
                ]
              },
              "audience": {
                "type": "string",
                "enum": [
                  "user",
                  "counterparty",
                  "internal"
                ]
              },
              "userBenefit": {
                "type": "string",
                "maxLength": 4000
              },
              "representation": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "actualQuestion",
                  "requiredFacts",
                  "relevantClaims",
                  "privateFindings",
                  "userReport"
                ],
                "properties": {
                  "actualQuestion": {
                    "type": "string",
                    "maxLength": 4000
                  },
                  "requiredFacts": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "relevantClaims": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "privateFindings": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  },
                  "userReport": {
                    "type": "array",
                    "maxItems": 24,
                    "items": {
                      "type": "string",
                      "maxLength": 4000
                    }
                  }
                }
              },
              "action": {
                "type": "string",
                "enum": [
                  "proceed",
                  "ask",
                  "defer",
                  "investigate"
                ]
              },
              "decisionRequired": {
                "type": "boolean"
              },
              "decisionReason": {
                "type": "string",
                "maxLength": 4000
              },
              "decisions": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "input",
                    "selectedOptionId"
                  ],
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "input": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "decision",
                        "assumptions",
                        "hardConstraints",
                        "options"
                      ],
                      "properties": {
                        "decision": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "horizon": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2400
                        },
                        "assumptions": {
                          "type": "array",
                          "maxItems": 32,
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2400
                          }
                        },
                        "hardConstraints": {
                          "type": "array",
                          "maxItems": 32,
                          "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "id",
                              "kind",
                              "rule",
                              "source",
                              "observedViolation",
                              "blockedOptionIds"
                            ],
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 120
                              },
                              "kind": {
                                "type": "string",
                                "enum": [
                                  "user_constraint",
                                  "required_authorization",
                                  "verified_requirement"
                                ]
                              },
                              "rule": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "source": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "observedViolation": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "blockedOptionIds": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 12,
                                "uniqueItems": true,
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 120
                                }
                              }
                            }
                          }
                        },
                        "options": {
                          "type": "array",
                          "minItems": 2,
                          "maxItems": 12,
                          "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": [
                              "id",
                              "action",
                              "reversibility",
                              "outcome",
                              "risks",
                              "delayCost",
                              "interruptionCost",
                              "opportunityCost"
                            ],
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 120
                              },
                              "action": {
                                "type": "string",
                                "enum": [
                                  "proceed",
                                  "ask",
                                  "defer"
                                ]
                              },
                              "reversibility": {
                                "type": "string",
                                "enum": [
                                  "reversible",
                                  "partly_reversible",
                                  "irreversible"
                                ]
                              },
                              "outcome": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2400
                              },
                              "risks": {
                                "type": "array",
                                "maxItems": 32,
                                "items": {
                                  "type": "object",
                                  "additionalProperties": false,
                                  "required": [
                                    "id",
                                    "probability",
                                    "severity",
                                    "probabilityBasis",
                                    "severityBasis"
                                  ],
                                  "properties": {
                                    "id": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 120
                                    },
                                    "probability": {
                                      "type": [
                                        "number",
                                        "null"
                                      ],
                                      "minimum": 0,
                                      "maximum": 1
                                    },
                                    "severity": {
                                      "type": [
                                        "number",
                                        "null"
                                      ],
                                      "minimum": 0,
                                      "maximum": 1000000
                                    },
                                    "probabilityRange": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "min",
                                        "max"
                                      ],
                                      "properties": {
                                        "min": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1
                                        },
                                        "max": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1
                                        }
                                      }
                                    },
                                    "severityRange": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "min",
                                        "max"
                                      ],
                                      "properties": {
                                        "min": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1000000
                                        },
                                        "max": {
                                          "type": "number",
                                          "minimum": 0,
                                          "maximum": 1000000
                                        }
                                      }
                                    },
                                    "probabilityBasis": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "kind",
                                        "rationale"
                                      ],
                                      "properties": {
                                        "kind": {
                                          "type": "string",
                                          "enum": [
                                            "assumption",
                                            "user_estimate",
                                            "empirical",
                                            "unknown"
                                          ]
                                        },
                                        "rationale": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "source": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "events": {
                                          "type": "integer",
                                          "minimum": 0,
                                          "maximum": 9007199254740991
                                        },
                                        "trials": {
                                          "type": "integer",
                                          "minimum": 1,
                                          "maximum": 9007199254740991
                                        }
                                      }
                                    },
                                    "severityBasis": {
                                      "type": "object",
                                      "additionalProperties": false,
                                      "required": [
                                        "anchor",
                                        "consequence",
                                        "conversionBasis"
                                      ],
                                      "properties": {
                                        "anchor": {
                                          "type": "string",
                                          "enum": [
                                            "none",
                                            "brief_rework",
                                            "bounded_rework",
                                            "substantial_rework",
                                            "material_setback",
                                            "major_loss",
                                            "unknown"
                                          ]
                                        },
                                        "consequence": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        },
                                        "conversionBasis": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 2400
                                        }
                                      }
                                    }
                                  }
                                }
                              },
                              "delayCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "interruptionCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "opportunityCost": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "value",
                                  "basis"
                                ],
                                "properties": {
                                  "value": {
                                    "type": [
                                      "number",
                                      "null"
                                    ],
                                    "minimum": 0,
                                    "maximum": 1000000
                                  },
                                  "basis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "zeroCostJustification": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              },
                              "clarification": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": [
                                  "baselineOptionId",
                                  "informationNeeded",
                                  "howAnswerChangesAction",
                                  "residualRiskBasis"
                                ],
                                "properties": {
                                  "baselineOptionId": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 120
                                  },
                                  "informationNeeded": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "howAnswerChangesAction": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  },
                                  "residualRiskBasis": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2400
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    "selectedOptionId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  }
                }
              },
              "chosenDecisionId": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 120
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            }
          }
        },
        "required": [
          "type",
          "userAgency"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "add"
          },
          "step": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "title": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "active",
                  "blocked",
                  "done",
                  "skipped"
                ]
              },
              "note": {
                "type": "string",
                "maxLength": 700
              },
              "doneWhen": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1000,
                "description": "Observable completion check. An inquiry may finish with confirmation, refutation or a bounded unresolved finding. A failed operation does not satisfy the requested effect."
              },
              "evidence": {
                "type": "string",
                "maxLength": 2000,
                "description": "Agent-reported work or check results, including limits. This is not runtime verification."
              },
              "blockedReason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1000,
                "description": "Required when blocked; describe the actual obstacle. Cleared when the milestone leaves blocked."
              },
              "parentId": {
                "type": [
                  "string",
                  "null"
                ],
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
                "description": "Parent group ID; null or omitted means a root child. Array order determines sibling order."
              },
              "kind": {
                "type": "string",
                "enum": [
                  "action",
                  "sequence",
                  "parallel",
                  "choice"
                ],
                "description": "An action has no children. Other kinds group actions and derive their status from them."
              },
              "dependsOn": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                },
                "maxItems": 199,
                "uniqueItems": true,
                "description": "Additional prerequisites that must be done before this path starts. Sequence order is already implicit."
              },
              "stepType": {
                "type": "string",
                "pattern": "^[A-Za-z0-9_-]{1,100}$",
                "description": "A saved descriptive step type from describe; it grants no tools."
              },
              "condition": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1000,
                "description": "Observable condition for this alternative; text alone never activates a branch."
              },
              "skipReason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1000,
                "description": "Required for a skipped action. Say why the work was deliberately not performed."
              },
              "result": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1000,
                "description": "Planned work product or desired operational state. For uncertain analysis, specify the answer to develop without predetermining its finding. Record the completed finding in evidence."
              },
              "artifactIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                },
                "maxItems": 20,
                "uniqueItems": true,
                "description": "IDs of actual deliverables already registered to this task."
              },
              "selectedChildId": {
                "type": [
                  "string",
                  "null"
                ],
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
                "description": "For a choice group, the direct child to follow. Update unused child actions to skipped with reasons; selection alone never claims completion."
              },
              "operation": {
                "anyOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "kind",
                      "tool",
                      "target"
                    ],
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "tool"
                      },
                      "tool": {
                        "type": "string",
                        "pattern": "^relay_[a-z_]{1,60}$"
                      },
                      "action": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 120
                      },
                      "target": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 1000
                      }
                    }
                  },
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "kind",
                      "target"
                    ],
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "reasoning"
                      },
                      "target": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 1000
                      }
                    }
                  }
                ],
                "description": "One bounded primary operation. Tool leaves name one exact attached relay tool, its action when exposed, and target; do not invent actions for actionless tools. Needed host-classified read-only observations may support it under the same active leaf. Reasoning leaves remain bounded questions without operational tool dispatch. Auxiliary observations do not replace the primary operation or become reconciliation proof."
              },
              "branch": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "if",
                  "then",
                  "else"
                ],
                "properties": {
                  "if": {
                    "$ref": "#/$defs/planExpression"
                  },
                  "then": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                  },
                  "elif": {
                    "type": "array",
                    "maxItems": 198,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "if",
                        "then"
                      ],
                      "properties": {
                        "if": {
                          "$ref": "#/$defs/planExpression"
                        },
                        "then": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                        }
                      }
                    }
                  },
                  "else": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                  }
                },
                "description": "Executable IF/ELIF/ELSE for an actual binding rule on a choice. Branch IDs are distinct direct children. Check IF then each ELIF in order; the first true condition selects its path, all false selects ELSE. An earlier unknown blocks fallthrough. Expressions recursively support and/or/not/xor and comparisons over observed constituent facts. Preserve the binding rule instead of substituting a model-computed readiness flag. Changed inputs reevaluate the same rule; selectedChildId is derived. A discretionary choice may omit branch and save selectedChildId with its supported judgment."
              },
              "reconciliation": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "callId",
                  "outcome",
                  "evidence"
                ],
                "properties": {
                  "callId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$",
                    "description": "The task-unique callId from the original planning.sequence annotation or unresolved-dispatch receipt, not the provider session call ID."
                  },
                  "outcome": {
                    "type": "string",
                    "enum": [
                      "confirmed",
                      "absent"
                    ]
                  },
                  "evidence": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  }
                },
                "description": "Only on a completed observation leaf: the actual finding from a later read-only check of one interrupted call. confirmed means the effect was observed; absent means checked absent. This preserves uncertainty until checked and never replays the original effect."
              }
            },
            "required": [
              "id",
              "title"
            ],
            "additionalProperties": false
          },
          "beforeId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
                "minLength": 1,
                "maxLength": 120
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "type",
          "step"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "update"
          },
          "stepId": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
            "minLength": 1,
            "maxLength": 120
          },
          "patch": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "pending",
                  "active",
                  "blocked",
                  "done",
                  "skipped"
                ]
              },
              "note": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 700
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "doneWhen": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "description": "Observable completion check. An inquiry may finish with confirmation, refutation or a bounded unresolved finding. A failed operation does not satisfy the requested effect."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "evidence": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 2000,
                    "description": "Agent-reported work or check results, including limits. This is not runtime verification."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "blockedReason": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "description": "Required when blocked; describe the actual obstacle. Cleared when the milestone leaves blocked."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "kind": {
                "type": "string",
                "enum": [
                  "action",
                  "sequence",
                  "parallel",
                  "choice"
                ],
                "description": "An action has no children. Other kinds group actions and derive their status from them."
              },
              "stepType": {
                "anyOf": [
                  {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9_-]{1,100}$",
                    "description": "A saved descriptive step type from describe; it grants no tools."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "condition": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "description": "Observable condition for this alternative; text alone never activates a branch."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "skipReason": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "description": "Required for a skipped action. Say why the work was deliberately not performed."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "result": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "description": "Planned work product or desired operational state. For uncertain analysis, specify the answer to develop without predetermining its finding. Record the completed finding in evidence."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "artifactIds": {
                "anyOf": [
                  {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                    },
                    "maxItems": 20,
                    "uniqueItems": true,
                    "description": "IDs of actual deliverables already registered to this task."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "operation": {
                "anyOf": [
                  {
                    "anyOf": [
                      {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                          "kind",
                          "tool",
                          "target"
                        ],
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "tool"
                          },
                          "tool": {
                            "type": "string",
                            "pattern": "^relay_[a-z_]{1,60}$"
                          },
                          "action": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 120
                          },
                          "target": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 1000
                          }
                        }
                      },
                      {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                          "kind",
                          "target"
                        ],
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "reasoning"
                          },
                          "target": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 1000
                          }
                        }
                      }
                    ],
                    "description": "One bounded primary operation. Tool leaves name one exact attached relay tool, its action when exposed, and target; do not invent actions for actionless tools. Needed host-classified read-only observations may support it under the same active leaf. Reasoning leaves remain bounded questions without operational tool dispatch. Auxiliary observations do not replace the primary operation or become reconciliation proof."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "branch": {
                "anyOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "if",
                      "then",
                      "else"
                    ],
                    "properties": {
                      "if": {
                        "$ref": "#/$defs/planExpression"
                      },
                      "then": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      },
                      "elif": {
                        "type": "array",
                        "maxItems": 198,
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "required": [
                            "if",
                            "then"
                          ],
                          "properties": {
                            "if": {
                              "$ref": "#/$defs/planExpression"
                            },
                            "then": {
                              "type": "string",
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                            }
                          }
                        }
                      },
                      "else": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      }
                    },
                    "description": "Executable IF/ELIF/ELSE for an actual binding rule on a choice. Branch IDs are distinct direct children. Check IF then each ELIF in order; the first true condition selects its path, all false selects ELSE. An earlier unknown blocks fallthrough. Expressions recursively support and/or/not/xor and comparisons over observed constituent facts. Preserve the binding rule instead of substituting a model-computed readiness flag. Changed inputs reevaluate the same rule; selectedChildId is derived. A discretionary choice may omit branch and save selectedChildId with its supported judgment."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "reconciliation": {
                "anyOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "callId",
                      "outcome",
                      "evidence"
                    ],
                    "properties": {
                      "callId": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$",
                        "description": "The task-unique callId from the original planning.sequence annotation or unresolved-dispatch receipt, not the provider session call ID."
                      },
                      "outcome": {
                        "type": "string",
                        "enum": [
                          "confirmed",
                          "absent"
                        ]
                      },
                      "evidence": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000
                      }
                    },
                    "description": "Only on a completed observation leaf: the actual finding from a later read-only check of one interrupted call. confirmed means the effect was observed; absent means checked absent. This preserves uncertainty until checked and never replays the original effect."
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [],
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "type",
          "stepId",
          "patch"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "remove"
          },
          "stepId": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
            "minLength": 1,
            "maxLength": 120
          }
        },
        "required": [
          "type",
          "stepId"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "move"
          },
          "stepId": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
            "minLength": 1,
            "maxLength": 120
          },
          "parentId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
                "minLength": 1,
                "maxLength": 120
              },
              {
                "type": "null"
              }
            ]
          },
          "beforeId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
                "minLength": 1,
                "maxLength": 120
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "type",
          "stepId",
          "parentId"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "dependencies"
          },
          "stepId": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
            "minLength": 1,
            "maxLength": 120
          },
          "dependsOn": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
            },
            "maxItems": 199,
            "uniqueItems": true,
            "description": "Additional prerequisites that must be done before this path starts. Sequence order is already implicit."
          }
        },
        "required": [
          "type",
          "stepId",
          "dependsOn"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "choose"
          },
          "stepId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
                "minLength": 1,
                "maxLength": 120
              },
              {
                "type": "null"
              }
            ]
          },
          "selectedChildId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
                "minLength": 1,
                "maxLength": 120
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "type",
          "stepId",
          "selectedChildId"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "metadata"
          },
          "patch": {
            "type": "object",
            "properties": {
              "goal": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "layout": {
                "type": "string",
                "enum": [
                  "sequence",
                  "parallel",
                  "choice"
                ],
                "description": "How root child paths relate. Sequence is ordered; parallel permits independent active paths; choice needs selectedChildId."
              },
              "detail": {
                "type": "string",
                "enum": [
                  "compact",
                  "balanced",
                  "detailed"
                ],
                "description": "Compact for a few actions, balanced for actionable substeps, detailed for finer decomposition. The request supplies its initial preference."
              },
              "focusStepId": {
                "type": [
                  "string",
                  "null"
                ],
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
              },
              "decisionCriteria": {
                "anyOf": [
                  {
                    "type": "array",
                    "maxItems": 24,
                    "description": "Optional, general-purpose decision rubric. Separate verified hard gates, substantial barriers, adaptable gaps, stated requirements, preferences and unresolved facts. Do not promote external claims to hard gates merely because they are written as requirements. Older job-specific kinds remain supported.",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "id",
                        "label",
                        "kind",
                        "source",
                        "basis"
                      ],
                      "properties": {
                        "id": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                        },
                        "label": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 180
                        },
                        "kind": {
                          "type": "string",
                          "enum": [
                            "hard_gate",
                            "material_barrier",
                            "adaptable_gap",
                            "stated_requirement",
                            "preference",
                            "unverified",
                            "substantial_skill",
                            "trainable_skill",
                            "employer_wishlist"
                          ]
                        },
                        "source": {
                          "type": "string",
                          "enum": [
                            "user",
                            "external",
                            "analyst",
                            "employer"
                          ]
                        },
                        "basis": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 700
                        },
                        "priority": {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 5
                        },
                        "verifiedNonNegotiable": {
                          "type": "boolean"
                        },
                        "evidenceStatus": {
                          "type": "string",
                          "enum": [
                            "confirmed",
                            "reported",
                            "inferred",
                            "unknown",
                            "contradicted"
                          ]
                        }
                      }
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "metacognition": {
                "anyOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "description": "Optional practical judgment frame. Record only the fields that change the decision; do not fill a ritual checklist.",
                    "properties": {
                      "outcome": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "The real-world result that matters, not just an output-format proxy."
                      },
                      "keyUncertainty": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "One assumption that could materially change the outcome, distinguishing unknown from disproved."
                      },
                      "nextProbe": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "A cheap concrete check or counterexample that could falsify the current assumption."
                      },
                      "goodEnough": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "A proportional sufficient result; do not require perfection."
                      },
                      "reassessWhen": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "When to stop, seek new evidence or change approach."
                      },
                      "observation": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "Observed outcome versus expectation, with its actual limits."
                      },
                      "lesson": {
                        "type": "string",
                        "maxLength": 700,
                        "description": "A concrete, transferable correction, not an automatic global rule."
                      }
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "facts": {
                "anyOf": [
                  {
                    "type": "array",
                    "maxItems": 200,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "id",
                        "value"
                      ],
                      "properties": {
                        "id": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                        },
                        "value": {
                          "anyOf": [
                            {
                              "type": "null"
                            },
                            {
                              "type": "boolean"
                            },
                            {
                              "type": "number"
                            },
                            {
                              "type": "string",
                              "maxLength": 2000
                            },
                            {
                              "type": "array",
                              "maxItems": 200,
                              "items": {
                                "anyOf": [
                                  {
                                    "type": "null"
                                  },
                                  {
                                    "type": "boolean"
                                  },
                                  {
                                    "type": "number"
                                  },
                                  {
                                    "type": "string",
                                    "maxLength": 2000
                                  }
                                ]
                              }
                            }
                          ]
                        },
                        "known": {
                          "type": "boolean",
                          "description": "Optional: false means unknown; true permits observed None/null. Default: non-null values are known and null is unknown."
                        },
                        "evidence": {
                          "type": "string",
                          "maxLength": 2000,
                          "description": "Actual basis for any known observation. Required and nonempty when known. Missing evidence is not a false condition."
                        }
                      }
                    },
                    "description": "Observed constituent values for binding Boolean conditions, with their actual sources. Do not present a model judgment as an observed aggregate fact; save qualitative judgments in reasoning evidence or a manual choice instead. Source-reported Boolean flags and direct binary observations remain valid facts. Keep missing evidence unknown."
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "branch": {
                "anyOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "if",
                      "then",
                      "else"
                    ],
                    "properties": {
                      "if": {
                        "$ref": "#/$defs/planExpression"
                      },
                      "then": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      },
                      "elif": {
                        "type": "array",
                        "maxItems": 198,
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "required": [
                            "if",
                            "then"
                          ],
                          "properties": {
                            "if": {
                              "$ref": "#/$defs/planExpression"
                            },
                            "then": {
                              "type": "string",
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                            }
                          }
                        }
                      },
                      "else": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$"
                      }
                    },
                    "description": "Executable IF/ELIF/ELSE for an actual binding rule on a choice. Branch IDs are distinct direct children. Check IF then each ELIF in order; the first true condition selects its path, all false selects ELSE. An earlier unknown blocks fallthrough. Expressions recursively support and/or/not/xor and comparisons over observed constituent facts. Preserve the binding rule instead of substituting a model-computed readiness flag. Changed inputs reevaluate the same rule; selectedChildId is derived. A discretionary choice may omit branch and save selectedChildId with its supported judgment."
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [],
            "additionalProperties": false,
            "minProperties": 1
          }
        },
        "required": [
          "type",
          "patch"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "type": {
            "const": "revisit"
          },
          "stepId": {
            "type": "string",
            "pattern": "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$",
            "minLength": 1,
            "maxLength": 120
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000,
            "description": "Revisit: what changed and why this earlier work needs another attempt. Save the preceding actual outcome before reopening it."
          }
        },
        "required": [
          "type",
          "stepId",
          "reason"
        ],
        "additionalProperties": false
      }
    ]
  }
};
