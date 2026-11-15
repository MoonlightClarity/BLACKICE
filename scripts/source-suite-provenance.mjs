import {execFileSync} from 'node:child_process';

// A workflow can check out a source unrelated to its controller's ancestry.
// GITHUB_SHA identifies the controller, never evidence of the tested checkout.
export function sourceSuiteIdentity(root,{controllerCommit=process.env.GITHUB_SHA,readHead=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()}={}){
 const sourceCommit=readHead();
 if(typeof sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Exact Git checkout identity required for source evidence.');
 if(controllerCommit!==undefined&&!/^[a-f0-9]{40}$/.test(controllerCommit))throw Error('Malformed workflow controller identity.');
 return {sourceCommit,workflowControllerCommit:controllerCommit??null,sourceCommitOrigin:'git-rev-parse-HEAD'};
}
