export const browserBindingReasons=Object.freeze(['reference-missing','reference-unknown','reference-evicted','document-changed','frame-changed','binding-mismatch','control-changed']);
export const browserBindingNumbers=Object.freeze(['observedRevision','currentRevision']);
export const browserBindingFlags=Object.freeze(['topUrlChanged','frameUrlChanged','frameLineageChanged']);
// Whitelist host-produced comparison fields. Do not persist locators, URLs, frame identities or page values.
export function projectBrowserReferenceDiagnostic(input){
 if(!browserBindingReasons.includes(input?.reason))return null;
 const safe={bindingReason:input.reason};
 for(const key of browserBindingNumbers){const value=input?.[key];if(Number.isSafeInteger(value)&&value>=0)safe[key]=value;}
 for(const key of browserBindingFlags){const value=input?.[key];if(typeof value==='boolean')safe[key]=value;}
 return safe;
}
