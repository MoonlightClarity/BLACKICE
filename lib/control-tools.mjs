import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {pastChatsWorkflowVisible} from './past-chats.mjs';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const revision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const textResult=(value,success=true)=>({success,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
export const CONTROL_TOOL={
  "type": "function",
  "name": "relay_control",
  "description": "Configure BLACKICE workflows, runtime preferences, Observe, concurrency and scheduled operations. Read current revisions before changes. Changes apply to future runs, not active snapshots.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "describe",
          "catalog",
          "workflow_get",
          "workflow_save",
          "step_update",
          "observe_get",
          "observe_set",
          "execution_get",
          "execution_set",
          "runtime_get",
          "runtime_set",
          "operations_list",
          "schedule_preview",
          "operations_pause",
          "operations_resume",
          "job_retry",
          "deployment_save",
          "deployment_update",
          "deployment_run",
          "job_get"
        ]
      },
      "id": {
        "type": "string"
      },
      "expectedRevision": {
        "type": "string"
      },
      "workflow": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "nodes": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string"
                },
                "type": {
                  "type": "string",
                  "enum": [
                    "input",
                    "agent",
                    "output"
                  ]
                },
                "name": {
                  "type": "string"
                },
                "prompt": {
                  "type": "string"
                },
                "model": {
                  "type": "string"
                },
                "effort": {
                  "type": "string",
                  "enum": [
                    "default",
                    "none",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                    "ultra"
                  ]
                },
                "serviceTier": {
                  "type": "string",
                  "enum": [
                    "default",
                    "fast"
                  ],
                  "description": "Standard or supported Codex Fast mode, independently of reasoning effort."
                },
                "desktop": {
                  "type": "boolean"
                },
                "x": {
                  "type": "number"
                },
                "y": {
                  "type": "number"
                },
                "context": {
                  "type": "object"
                }
              },
              "required": [
                "id",
                "type",
                "name"
              ],
              "additionalProperties": false
            }
          },
          "edges": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string"
                },
                "source": {
                  "type": "string"
                },
                "target": {
                  "type": "string"
                }
              },
              "required": [
                "source",
                "target"
              ],
              "additionalProperties": false
            }
          },
          "settings": {
            "type": "object",
            "properties": {
              "cwd": {
                "type": "string"
              },
              "maxParallel": {
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 1
              },
              "planningMode": {
                "type": "string",
                "enum": [
                  "on",
                  "off"
                ]
              },
              "planningExecutionMode": {
                "type": "string",
                "enum": [
                  "automatic"
                ],
                "description": "Only Automatic is executable. Historical plan_only values remain read-only."
              },
              "context": {
                "type": "object"
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "name",
          "nodes",
          "edges"
        ],
        "additionalProperties": false
      },
      "execution": {
        "type": "object",
        "properties": {
          "maxConcurrentRuns": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1
          }
        },
        "required": [
          "maxConcurrentRuns"
        ],
        "additionalProperties": false
      },
      "runtime": {
        "type": "object",
        "properties": {
          "defaultEffort": {
            "type": "string",
            "enum": [
              "default",
              "none",
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
              "ultra"
            ],
            "description": "Default reasoning for new tasks. Explicit step effort overrides it; default means model default."
          },
          "defaultServiceTier": {
            "type": "string",
            "enum": [
              "default",
              "fast"
            ],
            "description": "Speed default for new supported Codex chats only; does not change reasoning or existing chats."
          },
          "defaultContext": {
            "type": "object",
            "properties": {
              "preset": {
                "type": "string",
                "enum": [
                  "model",
                  "extended",
                  "900k",
                  "custom"
                ]
              },
              "windowTokens": {
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 4096,
                "maximum": 4000000
              },
              "autoCompact": {
                "type": "boolean"
              },
              "outputReserveTokens": {
                "type": "integer",
                "minimum": 256,
                "maximum": 128000
              },
              "headroomTokens": {
                "type": "integer",
                "minimum": 128,
                "maximum": 256000
              },
              "compactAtTokens": {
                "type": "integer",
                "minimum": 256,
                "maximum": 4000000
              },
              "keepRecentTokens": {
                "type": "integer",
                "minimum": 256,
                "maximum": 256000
              }
            },
            "additionalProperties": false
          },
          "subagentsEnabled": {
            "type": "boolean"
          },
          "maxSubagents": {
            "type": "integer",
            "minimum": 1,
            "maximum": 8
          },
          "runTimeoutMs": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1,
            "maximum": 9007199254740991,
            "description": "Per agent response time limit in milliseconds; null removes the total deadline."
          },
          "providerIdleTimeoutMs": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1,
            "maximum": 9007199254740991,
            "description": "API time without incoming bytes; null disables the inactivity timeout. Active streams and heartbeats reset this clock."
          }
        },
        "minProperties": 1,
        "additionalProperties": false
      },
      "nodeId": {
        "type": "string"
      },
      "step": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "type": {
            "type": "string",
            "enum": [
              "input",
              "agent",
              "output"
            ]
          },
          "name": {
            "type": "string"
          },
          "prompt": {
            "type": "string"
          },
          "model": {
            "type": "string"
          },
          "effort": {
            "type": "string",
            "enum": [
              "default",
              "none",
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
              "ultra"
            ]
          },
          "serviceTier": {
            "type": "string",
            "enum": [
              "default",
              "fast"
            ],
            "description": "Standard or supported Codex Fast mode, independently of reasoning effort."
          },
          "desktop": {
            "type": "boolean"
          },
          "x": {
            "type": "number"
          },
          "y": {
            "type": "number"
          },
          "context": {
            "type": "object"
          }
        },
        "additionalProperties": false
      },
      "presentation": {
        "type": "object"
      },
      "deployment": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "input": {
            "type": "string"
          },
          "cwd": {
            "type": "string"
          },
          "workflow": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "nodes": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string"
                    },
                    "type": {
                      "type": "string",
                      "enum": [
                        "input",
                        "agent",
                        "output"
                      ]
                    },
                    "name": {
                      "type": "string"
                    },
                    "prompt": {
                      "type": "string"
                    },
                    "model": {
                      "type": "string"
                    },
                    "effort": {
                      "type": "string",
                      "enum": [
                        "default",
                        "none",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max",
                        "ultra"
                      ]
                    },
                    "serviceTier": {
                      "type": "string",
                      "enum": [
                        "default",
                        "fast"
                      ],
                      "description": "Standard or supported Codex Fast mode, independently of reasoning effort."
                    },
                    "desktop": {
                      "type": "boolean"
                    },
                    "x": {
                      "type": "number"
                    },
                    "y": {
                      "type": "number"
                    },
                    "context": {
                      "type": "object"
                    }
                  },
                  "required": [
                    "id",
                    "type",
                    "name"
                  ],
                  "additionalProperties": false
                }
              },
              "edges": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string"
                    },
                    "source": {
                      "type": "string"
                    },
                    "target": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "source",
                    "target"
                  ],
                  "additionalProperties": false
                }
              },
              "settings": {
                "type": "object",
                "properties": {
                  "cwd": {
                    "type": "string"
                  },
                  "maxParallel": {
                    "type": [
                      "integer",
                      "null"
                    ],
                    "minimum": 1
                  },
                  "planningMode": {
                    "type": "string",
                    "enum": [
                      "on",
                      "off"
                    ]
                  },
                  "planningExecutionMode": {
                    "type": "string",
                    "enum": [
                      "automatic"
                    ],
                    "description": "Only Automatic is executable. Historical plan_only values remain read-only."
                  },
                  "context": {
                    "type": "object"
                  }
                },
                "additionalProperties": false
              }
            },
            "required": [
              "name",
              "nodes",
              "edges"
            ],
            "additionalProperties": false
          },
          "planningExecutionMode": {
            "type": "string",
            "enum": [
              "automatic"
            ],
            "description": "Only Automatic is executable. Historical plan_only values remain read-only."
          },
          "enabled": {
            "type": "boolean"
          },
          "overlap": {
            "type": "string",
            "enum": [
              "parallel",
              "queue",
              "skip"
            ]
          },
          "trigger": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "manual",
                  "webhook",
                  "interval",
                  "cron"
                ]
              },
              "everySeconds": {
                "type": "integer",
                "minimum": 1
              },
              "expression": {
                "type": "string",
                "description": "Five cron fields: minute hour day-of-month month day-of-week. Example 0 9 * * MON-FRI."
              },
              "timezone": {
                "type": "string",
                "description": "IANA timezone required for cron, for example America/New_York or UTC."
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": false
          },
          "limits": {
            "type": [
              "object",
              "null"
            ],
            "properties": {
              "maxIterations": {
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 1,
                "maximum": 9007199254740991,
                "description": "Maximum lifetime unique trigger admissions, including Run now. Retries and duplicate deliveries do not count."
              },
              "runForSeconds": {
                "type": [
                  "integer",
                  "null"
                ],
                "minimum": 1,
                "maximum": 9007199254740,
                "description": "Duration from first enable or manual admission. Pause/resume does not reset it."
              },
              "endAt": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "ISO end instant with explicit timezone, for example 2026-11-01T17:00:00-05:00."
              }
            },
            "additionalProperties": false
          },
          "retry": {
            "type": "object",
            "properties": {
              "maxAttempts": {
                "type": "integer",
                "minimum": 0,
                "maximum": 3
              },
              "backoffSeconds": {
                "type": "integer",
                "minimum": 1,
                "maximum": 3600
              }
            },
            "additionalProperties": false
          },
          "attachmentIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "expectedRevision": {
            "type": "integer"
          }
        },
        "additionalProperties": false
      },
      "trigger": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "manual",
              "webhook",
              "interval",
              "cron"
            ]
          },
          "everySeconds": {
            "type": "integer",
            "minimum": 1
          },
          "expression": {
            "type": "string",
            "description": "Five cron fields: minute hour day-of-month month day-of-week. Example 0 9 * * MON-FRI."
          },
          "timezone": {
            "type": "string",
            "description": "IANA timezone required for cron, for example America/New_York or UTC."
          }
        },
        "required": [
          "type"
        ],
        "additionalProperties": false
      },
      "count": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10
      },
      "input": {
        "type": "string"
      },
      "idempotencyKey": {
        "type": "string"
      },
      "resumeInbox": {
        "type": "boolean"
      },
      "reason": {
        "type": "string"
      }
    },
    "required": [
      "action"
    ],
    "additionalProperties": false
  }
};
export const CONTROL_INSTRUCTIONS = "\n\nAGENT CONFIGURATION\nUse catalog/workflow_get for actual IDs and revisions. Send only changed runtime fields. For nullable limit fields, null removes the app limit; requested context remains bounded by provider capacity. Runtime changes apply to future admissions, not active snapshots.\nFor clock-time schedules use a five-field cron trigger with its IANA timezone and check schedule_preview dates. Deployment limits govern new admissions; they do not cancel queued or running work. Retries do not consume another iteration. Inspect nextAt, limitStatus and scheduler pause state after a change. Observe settings control presentation; runtime evidence supplies actual work and status.\n";
export const CONTROL_SCHEMA_VERSION=14;
export function createControlToolHandler({engine,getOperations,getJournal,validateWorkflow,validatePresentation,run,nodeId,signal}){
  const check=()=>{if(signal?.aborted)throw signal.reason||Error('Task stopped.');};
  const visibleWorkflows=()=>engine.listWorkflows().filter(workflow=>pastChatsWorkflowVisible(run,workflow));
  const saved=id=>{const workflow=visibleWorkflows().find(item=>item.id===id);if(!workflow)throw Error('Workflow not found. Read catalog for saved workflow IDs.');return{workflow,revision:revision(workflow)};};
  const assertRevision=(args,current)=>{if(args.expectedRevision!==current.revision)throw Error('Workflow changed. Read workflow_get and use its current expectedRevision before saving.');};
  let tail=Promise.resolve();
  return (call,context={})=>{const operation=async()=>{try{
    check();if(context.signal?.aborted)throw Error('Tool call stopped.');if(call.name!=='relay_control')throw Error('Unknown control tool.');
    const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;if(!object(args))throw Error('Control arguments must be an object.');
    if(!CONTROL_TOOL.inputSchema.properties.action.enum.includes(args.action))throw Error('Choose an action from the current relay_control schema.');
    // Hermes-inspired recursion guard: scheduled workers may inspect cron,
    // but only a separately initiated user/agent turn may edit or fire it.
    if(run.metadata?.managedBy==='operations'&&['operations_resume','operations_pause','job_retry','deployment_save','deployment_update','deployment_run'].includes(args.action))
      throw Error('Scheduled executions cannot mutate or trigger recurring jobs. Make this change in an ordinary user-initiated task.');
    const operations=getOperations?.();let result;
    if(args.action==='describe')result={tool:CONTROL_TOOL,observePresentation:{version:1,title:'Optional short title',focus:'auto | edits | activity',file:'Optional relative file path',stepIds:['optional saved plan step IDs'],showAgents:true},deployment:{name:'Name',workflow:'Use a full saved workflow object',input:'Configured task',cwd:'Absolute folder',enabled:true,overlap:'parallel | queue | skip',trigger:{type:'manual | interval | webhook | cron',everySeconds:'Positive whole seconds, only for interval',expression:'Five fields, for example 0 9 * * MON-FRI, only for cron',timezone:'IANA timezone, for example America/New_York, required for cron'},limits:{maxIterations:'Optional positive lifetime admitted job count; null means no limit.',runForSeconds:'Optional positive whole duration from first activation, in seconds; null means no limit.',endAt:'Optional ISO instant with explicit timezone; null means no limit.'},retry:{maxAttempts:'0 to 3 additional retries',backoffSeconds:'1 to 3600'},attachmentIds:[]},notes:['Use workflow_get revision as expectedRevision to update existing workflows.','New graphs need one input, agents, and output; every step must connect to the output.','Parallel workflow branches run independently; maxParallel:null runs every ready branch. Windows background actions serialize at the tool queue, not the whole workflow.','runtime_set subagentsEnabled enables on-demand delegation and maxSubagents chooses 1-8 parallel child agents for future turns.','execution_set persists the user-selected concurrent task limit, with maxConcurrentRuns:null for no app limit. Lowering it never cancels running work.','Deployment overlap: parallel runs together, queue preserves triggers in FIFO order, skip coalesces busy scheduled ticks. New operations default to parallel.','runtime_get/runtime_set patches runTimeoutMs or providerIdleTimeoutMs (positive whole milliseconds or null for no limit) without changing unrelated preferences. New agent responses default to no total deadline and APIs default to five minutes without incoming bytes. Active work retains its saved settings.','Native chats use persistent resumable Codex history. API provider conversations retain their own saved histories.', 'Observe collects live file changes only while a user is watching.','Use schedule_preview with trigger and optional count (1 to 10) before saving a calendar schedule. Cron uses local calendar time in its IANA timezone; missing DST minutes skip, repeated minutes run twice. Restricted day-of-month and weekday fields use OR; wildcard day fields (including steps) use both matches. Resume uses the next future time and does not replay missed ticks.','Optional deployment limits stop only new admissions. maxIterations counts distinct manual, webhook, interval, and cron jobs over the deployment lifetime; automatic or explicit retries and repeated idempotency keys do not count. Queued and running admitted work finishes. runForSeconds starts on first enable or manual admission; pause, disable, resume and restart never reset it. endAt is an ISO instant with an explicit timezone. The first reached limit wins. Read admittedJobs, activatedAt and limitStatus on the returned deployment; extend or clear limits to admit more jobs. limits:null clears all limits.','Triggers execute directly; the app must remain running.']};
    else if(args.action==='catalog')result={models:engine.runtime.status().models||[],defaultModel:engine.runtime.status().defaultModel,cwd:run.cwd,currentRunId:run.id,currentWorkflowId:run.workflowId,execution:engine.executionStatus?.(),executionSettings:engine.executionSettings?.(),runtimeSettings:engine.runtimeSettings?.get(),workflows:visibleWorkflows().map(workflow=>({id:workflow.id,name:workflow.name,revision:revision(workflow),steps:workflow.nodes.length})),desktop:engine.desktop?.status(),operations:operations?.status()};
    else if(args.action==='execution_get'){result={...engine.executionSettings(),execution:engine.executionStatus()};}
    else if(args.action==='execution_set'){check();const settings=await engine.updateExecutionSettings(args.execution);result={...settings,execution:engine.executionStatus(),applies:'new starts; active work continues'};}
    else if(args.action==='runtime_get'){if(!engine.runtimeSettings)throw Error('Runtime preferences are unavailable.');result=engine.runtimeSettings.get();}
    else if(args.action==='runtime_set'){if(!engine.runtimeSettings)throw Error('Runtime preferences are unavailable.');check();result={...await engine.runtimeSettings.update(args.runtime),applies:'future agent responses; active work keeps its saved settings; existing per-chat reasoning/context choices and Codex entries remain unchanged'};}
    else if(args.action==='workflow_get')result=saved(args.id);
    else if(args.action==='workflow_save'){
      if(!object(args.workflow))throw Error('A workflow object is required.');const current=args.workflow.id&&engine.listWorkflows().find(item=>item.id===args.workflow.id);if(current&&!pastChatsWorkflowVisible(run,current))throw Error('Workflow not found. Read catalog for saved workflow IDs.');if(current)assertRevision(args,{revision:revision(current)});
      const workflow=validateWorkflow(args.workflow);check();const stored=await engine.saveWorkflow(workflow);result={workflow:stored,revision:revision(stored),applies:'future runs'};
    }else if(args.action==='step_update'){
      const current=saved(args.id);assertRevision(args,current);if(!object(args.step)||Object.keys(args.step).some(key=>!Object.hasOwn(CONTROL_TOOL.inputSchema.properties.workflow.properties.nodes.items.properties,key)))throw Error('Use the documented step fields.');
      const node=current.workflow.nodes.find(item=>item.id===args.nodeId);if(!node)throw Error('Step not found.');if(args.step.id&&args.step.id!==node.id||args.step.type&&args.step.type!==node.type)throw Error('Step identity and type cannot change in step_update.');
      Object.assign(node,args.step);const workflow=validateWorkflow(current.workflow);check();const stored=await engine.saveWorkflow(workflow);result={workflow:stored,revision:revision(stored),applies:'future runs'};
    }else if(args.action==='observe_get')result={presentation:run.observePresentation||{version:1,focus:'auto'},watching:Boolean(getJournal?.()?.snapshot(run.id)),collection:'Only while Observe is open'};
    else if(args.action==='observe_set'){
      const presentation=validatePresentation(args.presentation);check();run.observePresentation=presentation;engine.notify('observe.presentation',run,nodeId,presentation);result={presentation,applies:'current Observe view'};
    }else if(args.action==='schedule_preview'){if(!operations)throw Error('Operations are unavailable.');result=operations.previewSchedule({trigger:args.trigger,count:args.count});}
    else if(args.action==='operations_list'){if(!operations)throw Error('Operations are unavailable.');result=operations.snapshot();}
    else if(args.action==='operations_resume'){if(!operations)throw Error('Operations are unavailable.');check();result=await operations.resume({resumeInbox:args.resumeInbox===true});}
    else if(args.action==='operations_pause'){if(!operations)throw Error('Operations are unavailable.');check();result=await operations.pause(args.reason||'Paused through chat.');}
    else if(args.action==='job_retry'){if(!operations)throw Error('Operations are unavailable.');check();result=await operations.retryJob(args.id);}
    else if(['deployment_save','deployment_update'].includes(args.action)){
      if(!operations||!object(args.deployment))throw Error('A deployment definition is required.');
      const definition=args.deployment;
      if(definition.cwd!==undefined||args.action==='deployment_save'){if(typeof definition.cwd!=='string'||!(await stat(definition.cwd)).isDirectory())throw Error('Choose an existing working folder.');}
      if(definition.attachmentIds!==undefined)engine.attachments?.validateIds(definition.attachmentIds);
      check();result=args.action==='deployment_save'?await operations.create(definition,{actor:'agent'}):await operations.update(args.id,definition,{actor:'agent'});
    }else if(args.action==='deployment_run'){if(!operations)throw Error('Operations are unavailable.');check();result=await operations.trigger(args.id,{source:'manual',idempotencyKey:args.idempotencyKey||`${run.id}:${nodeId}:${args.id}`,payload:args.input?{input:args.input}:{}});}
    else if(args.action==='job_get'){if(!operations)throw Error('Operations are unavailable.');result=operations.getJob(args.id);}
    else throw Error('Choose an action from the relay_control schema.');
    return textResult(result);
  }catch(error){return textResult({error:error.message},false);}};const pending=tail.catch(()=>{}).then(operation);tail=pending;return pending;};
}
