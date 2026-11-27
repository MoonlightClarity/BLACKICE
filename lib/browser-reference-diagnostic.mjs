import { projectPointerEvidence } from '../public/next/chat/tool-failure.mjs';
export { projectPointerEvidence };

export const browserBindingReasons=Object.freeze(['reference-missing','reference-unknown','reference-evicted','document-changed','frame-changed','binding-mismatch','control-changed','input-identity-invalid','input-url-mismatch','input-document-mismatch','input-reference-mismatch']);
export const browserBindingNumbers=Object.freeze(['observedRevision','retiredAtRevision','currentRevision','requestedRevision']);
export const browserBindingEvents=Object.freeze(['frame-navigation','in-page-navigation','renderer-gone','tab-suspended']);
export const browserBindingFlags=Object.freeze(['topUrlChanged','frameUrlChanged','frameLineageChanged']);
export const browserControlBindingCauses=Object.freeze(['control-disconnected','hidden','no-box','identity-changed']);
export const browserControlBindingPhases=Object.freeze(['fill','fill-ready']);
export const browserControlBindingMismatchFlags=Object.freeze(['controlTagChanged','controlTypeChanged','controlRoleChanged','controlNameChanged']);

// Renderer data can only contribute bounded cause/field markers. Phase is host supplied.
export function projectBrowserControlBinding(input, phase=input?.controlBindingPhase){
 const cause=input?.controlBindingCause;
 if(!browserControlBindingCauses.includes(cause))return {};
 const safe={controlBindingCause:cause};
 if(browserControlBindingPhases.includes(phase))safe.controlBindingPhase=phase;
 if(cause==='identity-changed')for(const key of browserControlBindingMismatchFlags)if(input[key]===true)safe[key]=true;
 return safe;
}

// Whitelist host-produced comparison fields. Do not persist locators, URLs, frame identities or page values.
export function projectBrowserReferenceDiagnostic(input){
 if(!browserBindingReasons.includes(input?.reason))return null;
 const safe={bindingReason:input.reason,...projectBrowserControlBinding(input)};
 if(browserBindingEvents.includes(input.bindingEvent))safe.bindingEvent=input.bindingEvent;
 if(['layout-metrics','hit-location','resolve-hit','verify-hit','viewport-recheck'].includes(input.pointerCheck))safe.pointerCheck=input.pointerCheck;
 if(safe.pointerCheck)Object.assign(safe,projectPointerEvidence(input));
 if(safe.pointerCheck==='verify-hit'&&['renderer-exception','hit-mismatch','no-verification',...browserControlBindingCauses].includes(input.pointerVerification))
   safe.pointerVerification=input.pointerVerification;
 for(const key of browserBindingNumbers){const value=input?.[key];if(Number.isSafeInteger(value)&&value>=0)safe[key]=value;}
 for(const key of browserBindingFlags){const value=input?.[key];if(typeof value==='boolean')safe[key]=value;}
 return safe;
}
