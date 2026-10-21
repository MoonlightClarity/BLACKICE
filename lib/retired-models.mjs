// Keep historical routing identities reserved without loading a browser provider.
export const RETIRED_CHAT_MODE_MODEL = 'chatgpt::chat-mode';
export const CHAT_MODE_RETIRED_MESSAGE = 'ChatGPT Chat Mode has been retired. Use the BLACKICE connection from ChatGPT, or choose a supported model in BLACKICE. Saved conversations and drafts are kept.';
export const isRetiredChatModeThread = value => typeof value === 'string' && /^provider_chatmode_[a-f0-9-]{36}$/.test(value);
export const retiredChatModeError = () => Object.assign(new Error(CHAT_MODE_RETIRED_MESSAGE), { code: 'CHAT_MODE_RETIRED', status: 410 });
