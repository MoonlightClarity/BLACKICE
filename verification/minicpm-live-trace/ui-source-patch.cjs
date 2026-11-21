'use strict';
// Output-track the already-disabled, empty UI profile. Enabled UI is upstream.
const expected={'tools/ui/CMakeLists.txt':'51b6c585fab1dcb59a44aad2bf81b927fa3e62a6ac33308a82f93b604ff6bf72'};
const dependencyPins={
 'scripts/ui-assets.cmake':'d3abf3ced6aa329a000b6c0df9c19fabfa83581d95f90b1cdd686007edb5fa8e',
 'tools/ui/ui.cpp.in':'f23eb7c1b26992138f8f69e7bf45533ae8928de849f26839c0a9c6456043b1ea',
 'tools/ui/ui.h.in':'9153477cacbcef7d44eb43bf02610cc6e131cc749e63f36b28a609cde51244f6',
};
// Observed unchanged Windows output of the pinned generator and templates,
// with no source/binary dist input and both UI options disabled. No private
// historical file is needed to reproduce or validate these deterministic bytes.
const emptyOutputs={
 'tools/ui/ui.cpp':{bytes:730,sha256:'8d4f2e2e51b9744bf14739835e175bd549605e2ce78650c762514a16038574df'},
 'tools/ui/ui.h':{bytes:586,sha256:'629b2bf69f622cdcd3d74842421eae4e5b49a7209555f4fd2c51e00a701cb943'},
};
function patch(file,input){
 if(!Object.hasOwn(expected,file))throw Error('UI_PATCH_TARGET');
 const begin='add_custom_target(llama-ui-assets ALL\n',end='\nset_source_files_properties(${UI_CPP} ${UI_H} PROPERTIES GENERATED TRUE)';
 const a=input.indexOf(begin),b=input.indexOf(end,a);
 if(a<0||b<0||input.indexOf(begin,a+begin.length)>=0)throw Error('UI_PATCH_ANCHOR');
 const upstream=input.slice(a,b).trimEnd();
 let tracked=upstream.replace('add_custom_target(llama-ui-assets ALL\n    BYPRODUCTS ${UI_CPP} ${UI_H}',
  'add_custom_command(\n    OUTPUT ${UI_CPP} ${UI_H}');
 if(tracked===upstream)throw Error('UI_PATCH_OUTPUT_ANCHOR');
 tracked=tracked.replace('    COMMENT "Provisioning UI assets"',
  '    DEPENDS\n        "${PROJECT_SOURCE_DIR}/scripts/ui-assets.cmake"\n        "${CMAKE_CURRENT_SOURCE_DIR}/ui.cpp.in"\n        "${CMAKE_CURRENT_SOURCE_DIR}/ui.h.in"\n        "${CMAKE_COMMAND}"\n    COMMENT "Provisioning UI assets"');
 const branch='if(NOT LLAMA_BUILD_UI AND NOT LLAMA_USE_PREBUILT_UI)\n'+
  '    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/dist/index.html" OR EXISTS "${CMAKE_CURRENT_BINARY_DIR}/dist/index.html")\n'+
  '        message(FATAL_ERROR "BLACKICE disabled-UI qualification requires no source or binary dist input")\n'+
  '    endif()\n'+tracked+'\nadd_custom_target(llama-ui-assets ALL DEPENDS ${UI_CPP} ${UI_H})\n'+
  'else()\n'+upstream+'\nendif()\n';
 return input.slice(0,a)+branch+input.slice(b);
}
module.exports={expected,dependencyPins,emptyOutputs,patch};
