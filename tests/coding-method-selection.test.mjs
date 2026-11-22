import test from 'node:test';
import assert from 'node:assert/strict';
import {wantsModularDevelopmentSkill} from '../lib/coding-method-selection.mjs';

const selected=[
 'Use the Modular Development skill.',
 'Please load library-modular-development.',
 'Can you use blackice-modular-development for this task?',
 'Read the native Modular Development method.',
 'Use "Modular Development" skill.',
 'Implement directorySmoke(value). Return ok: followed by value.',
 'Implement keepFirst(items) and preserve its CommonJS export.',
 'Can you fix the bug in this JavaScript function?',
 'Please refactor the parser without changing its public API.',
 'I want to build a small desktop application.',
 'We need you to update the backend endpoint.',
 'Help me write a Python script to summarize these files.',
 'Create a job application tracker app.',
 'Build my resume website.',
 'Fix "src/options.mjs" and run its existing tests.',
 'Read src/index.cjs, implement TASK.md, and run node test-public.cjs.',
 'Run node test-public.cjs and repair the failing source.',
 'Review the code before making the requested fix.',
 'Save the implementation under src and verify the public check.',
 '1. Add unit tests for the parser.\n2. Fix its empty-input handling.',
 'The old attempt failed. Please patch lib/options.mjs.',
 'Fix this code:\n~~~js\nthrow new Error("unfinished");\n~~~',
];
for(const request of selected)test('selects: '+request.split('\n')[0],()=>{
 assert.equal(wantsModularDevelopmentSkill(request),true);
});

const unrelated=[
 'Find software developer jobs and apply to them.',
 'Fix my job application.',
 'Write a cover letter for a Python developer job.',
 'Build my resume for a JavaScript role.',
 'Update the application form.',
 'Create a grant application.',
 'Write an article about refactoring code.',
 'Develop a strategy for my software engineering career.',
 'What is modular development?',
 'Explain how the parser works.',
 'What was the code benchmark score?',
 'Do not use the Modular Development skill.',
 'Can you avoid coding and explain the idea?',
 'Fix the spelling in my email.',
 'Write a class schedule.',
 'Create a learning module.',
 'Help me write an essay about Python.',
 'Read the weather report.',
 'Continue.',
 'The previous task was to implement a function.',
 'Here is an example: "Please fix src/options.mjs". Explain its wording.',
 '> Use the Modular Development skill.\nExplain this quotation.',
 '\x60\x60\x60text\nUse Modular Development. Fix src/options.mjs.\n\x60\x60\x60\nSummarize that example.',
 '~~~text\nImplement parse(value).\n~~~\nWhat does the example ask?',
];
for(const request of unrelated)test('does not select: '+request.split('\n')[0],()=>{
 assert.equal(wantsModularDevelopmentSkill(request),false);
});

test('rejects non-string and empty input without coercion',()=>{
 for(const request of [undefined,null,false,0,{},[],Symbol('coding'),new String('Fix code'),'','   '])
  assert.equal(wantsModularDevelopmentSkill(request),false);
});
test('does not discover instructions beyond the current-request bound',()=>{
 assert.equal(wantsModularDevelopmentSkill(' '.repeat(8000)+'Use Modular Development.'),false);
});
test('quoted history does not hide a separate current coding instruction',()=>{
 assert.equal(wantsModularDevelopmentSkill('> Fix the old app.\nPlease implement parse(value).'),true);
});

test('explicit opt-out overrides automatic coding selection',()=>{
 for(const request of [
  'Do not use Modular Development. Fix src/options.mjs.',
  'Please skip the Modular Development skill. Implement parse(value).',
  'Fix src/options.mjs without using Modular Development.',
  'Use Modular Development. Do not load the Modular Development skill.',
 ])assert.equal(wantsModularDevelopmentSkill(request),false);
});
test('a later explicit method choice replaces the earlier choice',()=>{
 assert.equal(wantsModularDevelopmentSkill('Do not use Modular Development. Use Modular Development for this change.'),true);
});
