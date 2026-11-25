import {validateFileSearchCall} from './file-search-contract.mjs';
// A narrowly bounded repair for the local model's observed parameter framing leak.
// Never repair effectful calls, ambiguous fragments, or change supplied roots/cursors.
export function repairLocalReadArguments(name,args) {
  if (name !== 'relay_find_files' || typeof args?.query !== 'string' ||
      args.path !== undefined || args.roots !== undefined || args.cursor !== undefined) return args;
  const match = /^([^\r\n\u0000<>]{1,256})\r?\n<\/<\/parameter>\r?\n<parameter=path>\r?\n\/$/.exec(args.query);
  if (!match || !match[1].trim()) return args;
  const candidate={...args,query:match[1],path:'/'};
  try {validateFileSearchCall(candidate);return candidate;} catch {return args;}
}
