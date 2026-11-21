const text = { type: 'string' };
export const EMAIL_TOOL={
  "type": "function",
  "name": "relay_email",
  "description": "Read and send email through BLACKICE's configured background transport.\nstatus shows configuration. mailboxes returns folder IDs; list/search returns message IDs; read returns message text without changing unread flags.\ndraft creates a local unsent .eml file. compose prepares a sendable message from from/to/cc/bcc, subject, body and attachment paths, copying the attachment bytes. send takes that composed id and its own stable requestId.\nRead the returned state: prepared is unsent; queued is pending; sent/transportAccepted means the transport accepted it; uncertain means it may have left. Use deliveries/get_delivery to inspect an existing send after uncertainty. These actions do not open a GUI mail client.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "action"
    ],
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "status",
          "mailboxes",
          "list",
          "search",
          "read",
          "draft",
          "drafts",
          "get_draft",
          "compose",
          "send",
          "deliveries",
          "get_delivery"
        ]
      },
      "folder": {
        "type": "string",
        "maxLength": 512
      },
      "query": {
        "type": "string",
        "maxLength": 2000
      },
      "id": {
        "type": "string",
        "maxLength": 512
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100000
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "requestId": {
        "type": "string",
        "maxLength": 100
      },
      "to": {
        "type": "array",
        "minItems": 1,
        "maxItems": 50,
        "items": {
          "type": "string",
          "maxLength": 254
        }
      },
      "subject": {
        "type": "string",
        "maxLength": 998
      },
      "body": {
        "type": "string",
        "maxLength": 256000
      },
      "from": {
        "type": "string",
        "minLength": 1,
        "maxLength": 254,
        "description": "Exact sender mailbox for compose."
      },
      "cc": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "string",
          "maxLength": 254
        }
      },
      "bcc": {
        "type": "array",
        "maxItems": 50,
        "items": {
          "type": "string",
          "maxLength": 254
        }
      },
      "attachments": {
        "type": "array",
        "maxItems": 20,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32767
        },
        "description": "Absolute local file paths for compose. Bytes are copied and hashed before sending; export task attachments to working copies first when needed."
      }
    }
  }
};
export const EMAIL_SCHEMA_VERSION=2;
export const EMAIL_INSTRUCTIONS = "\n\nBACKGROUND EMAIL\nUse status for configured capabilities, mailboxes for folder IDs, and list/search/read for messages. Search uses the configured client's envelope syntax, for example \"from alice@example.org\" or \"subject meeting\". Follow page/limit/mayHaveMore; indexingPending, warnings and truncation identify incomplete results.\nFor sending, compose with exact sender/recipients, subject/body, optional absolute attachment paths and a stable requestId. Export a chat attachment with relay_files first when a local path is needed. compose returns an immutable message id; send uses that id and a separate stable requestId. A local draft is not a composed sendable message.\nIf a response is lost, inspect deliveries/get_delivery and reuse the original requestId for the same action. queued remains pending; uncertain may already have been dispatched. A queued message is already scheduled; keep its queueId and inspect that delivery instead of issuing another send. A sent/transportAccepted result confirms transport acceptance, not recipient acknowledgment. Report the returned state and any concrete failure.\n";

export function createEmailToolHandler({ store, signal } = {}) {
  const tool = EMAIL_TOOL;
  return async (call, context = {}) => {
    try {
      if (!store) throw Object.assign(new Error('The email workspace is unavailable.'), { code: 'EMAIL_UNAVAILABLE', status: 503 });
      if (call.name !== tool.name) throw new Error('Unknown email tool.');
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) throw new Error('Use the supported email tool fields.');
      if (!tool.inputSchema.properties.action.enum.includes(args.action)) throw new Error('Choose a supported relay_email action.');
      const specificFields = { compose: ['requestId', 'from', 'to', 'cc', 'bcc', 'subject', 'body', 'attachments'], send: ['id', 'requestId'], deliveries: ['page', 'limit'], get_delivery: ['id'] }[args.action];
      if (specificFields && Object.keys(args).some(key => key !== 'action' && !specificFields.includes(key))) throw new Error(`Use only ${specificFields.length ? specificFields.join(', ') : 'action'} with email ${args.action}.`);
      const active = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal;
      if (active?.aborted) throw Object.assign(new Error('Email operation cancelled.'), { code: 'ABORT_ERR', status: 409 });
      let result;
      switch (args.action) {
        case 'status': {
          result = store.status({ activeConnectionOnly: true });
          // Re-establish local binary/config evidence after a restart. This only
          // checks version/help; it never authenticates or reads a mailbox.
          if (result.enabled && result.configured && !result.cli?.checked) {
            await store.check({ signal: active }); result = store.status({ activeConnectionOnly: true });
          }
          break;
        }
        case 'mailboxes': result = await store.mailboxes({}, { signal: active }); break;
        case 'list': result = await store.list({ folder: args.folder, page: args.page, limit: args.limit }, { signal: active }); break;
        case 'search': if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('Search requires a nonempty email query.'); result = await store.list({ folder: args.folder, query: args.query, page: args.page, limit: args.limit }, { signal: active }); break;
        case 'read':
          if ((typeof args.folder !== 'string' || !args.folder.trim())) throw Object.assign(new Error('Email read requires the exact source folder and folder-scoped message ID returned by list/search. Supply folder and id from the same result; do not substitute the Message-ID header for id.'), { code: 'EMAIL_FOLDER_REQUIRED', status: 400 });
          result = await store.read({ folder: args.folder, id: args.id }, { signal: active }); break;
        case 'draft': result = await store.draft({ requestId: args.requestId, to: args.to, subject: args.subject, body: args.body }); break;
        case 'drafts': result = { drafts: store.listDrafts() }; break;
        case 'get_draft': result = store.getDraft(args.id); break;
        case 'compose': result = await store.compose({ requestId: args.requestId, from: args.from, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body, attachments: args.attachments }, { signal: active }); break;
        case 'send': result = await store.send({ id: args.id, requestId: args.requestId }, { signal: active }); break;
        case 'deliveries': {
          const paged = Object.hasOwn(args, 'page') || Object.hasOwn(args, 'limit');
          const page = Object.hasOwn(args, 'page') ? args.page : 1;
          const limit = Object.hasOwn(args, 'limit') ? args.limit : 20;
          if (paged && (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100)) throw Object.assign(new Error('Email deliveries page must be an integer from 1 to 100000 and limit must be an integer from 1 to 100.'), { code: 'EMAIL_INVALID', status: 400 });
          const deliveries = await store.listDeliveries();
          const offset = (page - 1) * limit;
          result = paged ? { deliveries: deliveries.slice(offset, offset + limit), total: deliveries.length, page, limit, mayHaveMore: offset + limit < deliveries.length } : { deliveries };
          break;
        }
        case 'get_delivery': result = await store.getDelivery(args.id); break;
      }
      return { success: args.action !== 'send' || result?.state === 'sent' && result?.sent === true || result?.state === 'queued' && result?.sent === false, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) {
      return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.status ? { status: error.status } : {}) }) }] };
    }
  };
}
