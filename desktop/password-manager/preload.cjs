const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('blackicePasswords',{request:value=>ipcRenderer.invoke('blackice:password-manager',value)});
