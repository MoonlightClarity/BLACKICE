/** Refresh only the BLACKICE interface, not active Goals or browser tasks. */
export function interfaceReloadInput(input){
 if(!input||input.type!=='keyDown'||input.isAutoRepeat===true||input.alt===true)return false;
 const key=String(input.key||input.keyCode||input.code||'').toLowerCase();
 if(key==='f5')return input.control!==true&&input.meta!==true;
 return key==='r'&&(input.control===true||input.meta===true);
}
export function bindInterfaceReloadShortcuts(contents){
 if(!contents||typeof contents.on!=='function'||typeof contents.reloadIgnoringCache!=='function')throw new TypeError('Expected Electron webContents');
 const onInput=(event,input)=>{
  if(!interfaceReloadInput(input))return;
  event.preventDefault();
  contents.reloadIgnoringCache();
 };
 contents.on('before-input-event',onInput);
 return ()=>contents.off('before-input-event',onInput);
}