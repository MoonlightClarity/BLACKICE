/** Canonicalize a historically overloaded tool-field spelling without
 * weakening the native form guard. A fill with value:string and no text is the
 * same request as fill with text:string. Conflicts, nonstrings, select actions
 * and missing fields are left untouched and must be validated separately.
 *
 * This pure canonical form is shared by dispatch and effect signatures;
 * otherwise an equivalent retry could evade an unresolved effect hold.
 */
export function normalizeBrowserFillRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || args.action !== 'fill' || args.text !== undefined
      || typeof args.value !== 'string') return args;
  const { value, ...rest } = args;
  return { ...rest, text: value };
}
