import {createHash} from 'node:crypto';
import {PLANNING_ONTOLOGY_MODULES, planningOntologyInstructions} from '../public/planning-module-policy.mjs';
/** Host assembly evidence only. It does not observe the model's reasoning. */
export function moduleActivationReceipt({configuredPolicy, effectivePolicy, instructions='', tools=[], executionPath='standard'}={}) {
 const block=effectivePolicy ? planningOntologyInstructions(effectivePolicy) : '';
 const included=Boolean(block && instructions.includes(block));
 return {version:1, source:'host-instruction-assembly', executionPath, state:'prepared', providerAcceptance:'unverified', adherence:'unverified',
 developerInstructionsSha256:createHash('sha256').update(instructions).digest('hex'),
 modules:PLANNING_ONTOLOGY_MODULES.map(({id})=>({id,configured:configuredPolicy?.modules?.[id]??null,
 effective:id==='subagents'?tools.some(tool=>tool.name==='relay_delegate'):effectivePolicy?.modules?.[id]===true,
 mechanism:id==='subagents'?'optional-tool':'developer-instructions',
 instructionIncluded:id==='subagents'?null:Boolean(effectivePolicy?.modules?.[id]&&included),
 ...(id==='subagents'?{toolAttached:tools.some(tool=>tool.name==='relay_delegate')}:{})})),
 note:'Configured choices are not activation. Instruction inclusion concerns only developer instructions, not tool descriptions. Runtime dispatch does not prove provider acceptance, model adherence or completed work. Optional delegation remains independent of Planning Off.'};
}
