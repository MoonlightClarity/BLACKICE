/** Directory is retired, not silently downgraded. Stored records remain untouched. */
export const DIRECTORY_RETIREMENT = Object.freeze({available:false,code:'DIRECTORY_RETIRED',reason:'Directory execution is unavailable because cross-conversation context isolation is not established. Existing records are preserved. Start a new conversation with Directory Off.'});
export function assertDirectoryAvailable(){throw Object.assign(new Error(DIRECTORY_RETIREMENT.reason),{code:DIRECTORY_RETIREMENT.code,status:410});}
