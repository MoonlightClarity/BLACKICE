import { app, session } from 'electron';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ElectronBrowserDriver } from '../../desktop/browser-driver.mjs';
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
if(!out||!path.isAbsolute(out))throw Error('Absolute disposable output required');
await fs.mkdir(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));
app.on('window-all-closed',()=>{});
let driver,server;const report={liveUserData:false,checks:[]};
setTimeout(()=>{console.error('fixture timeout');app.exit(1)},12000);
app.whenReady().then(async()=>{
try {
 const browserSession=session.fromPartition('persist:relay-agent-browser-v2');
 let calls=0;browserSession.extensions.loadExtension=async()=>{calls++;throw Error('Owned injected missing auxiliary extension');};
 driver=await new ElectronBrowserDriver({dataDir:path.join(out,'data'),downloadDir:path.join(out,'downloads')}).init();
 assert.equal(driver.status().compatibility.state,'degraded');assert.equal(driver.status().compatibility.verified,false);
 report.checks.push('Actual driver starts after auxiliary extension failure and reports degraded, not ready');
 server=http.createServer((req,res)=>res.end('<title>Ordinary page</title><h1>'+req.url+'</h1>'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const tab=driver.newTab(origin+'/first',{humanCreated:true});await tab.loading;
 assert.equal(tab.window.webContents.getTitle(),'Ordinary page');
 await tab.window.webContents.loadURL(origin+'/second');assert.equal(tab.window.webContents.getURL(),origin+'/second');
 report.checks.push('Real Chromium navigation and page rendering remain available');
 await tab.window.webContents.executeJavaScript('window.open('+JSON.stringify(origin+'/popup')+'); undefined');
 for(let i=0;i<100&&driver.tabs.size<2;i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(driver.tabs.size,2);report.checks.push('Ordinary popup still opens after shim failure');
 assert.equal(calls,1);report.checks.push('No duplicate auxiliary load or implicit retry');
 report.ok=true;
} catch(e){report.error=e.stack;report.ok=false;}
finally {try{await driver?.close();server?.close();}catch{}await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);}

});
