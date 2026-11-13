// The same Chromium/Electron runtime as BLACKICE, with a disposable profile.
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();
const profile=process.argv.find(value=>value.startsWith('--user-data-dir='));
if(profile)app.setPath('userData',profile.slice('--user-data-dir='.length));
app.whenReady().then(()=>{const window=new BrowserWindow({show:false,width:1360,height:950,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});window.loadURL('about:blank');});
app.on('window-all-closed',()=>app.quit());
