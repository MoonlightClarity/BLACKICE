const {app,BrowserWindow}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-visual-render-'));app.setPath('userData',profile);
app.whenReady().then(async()=>{
 const {compileVisual}=await import('../public/visual-document.mjs');
 const results=[];const win=new BrowserWindow({show:false,width:1200,height:1200,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try{
  for(const version of [1,2])for(const [x,y,horizontal,diagonal] of [[0,0,false],[120,0,false],[0,0,true],[0,100,true],[0,0,false,true]]){
   for(const label of ['Relation','Unicode \u0627\u0644\u0639\u0631\u0628\u064a\u0629 \ud83d\udc69\u200d\ud83d\udcbb WWW','Wide WWW \u4e2d\u6587 \ud83e\uddea e\u0301 relationship '.repeat(2).trim()]){
    const input={version,kind:'composed',title:'Render',summary:'Render',width:200,height:150,items:[{id:'a',label:'A',x,y,width:80,height:50},{id:'b',label:'B',x:horizontal||diagonal?120:x,y:horizontal?y:100,width:80,height:50}],links:[{from:'a',to:'b',label,uncertain:true},{from:'b',to:'a',label:'Counterpoint'}]};
    const {svg}=compileVisual(input);await win.loadURL('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg));
    const r=await win.webContents.executeJavaScript(`(()=>{const svg=document.querySelector('svg'),v=svg.viewBox.baseVal,failures=[],placed=[],obstacles=[...svg.children].filter(e=>e.tagName==='rect').slice(1).map(e=>e.getBBox()),overlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;for(const g of svg.querySelectorAll('g')){const rect=g.querySelector('rect').getBBox();if([...obstacles,...placed].some(o=>overlap(rect,o)))failures.push('label box overlaps item or other label');placed.push(rect);for(const t of g.querySelectorAll('text')){const b=t.getBBox();if(b.x<rect.x-.1||b.y<rect.y-.1||b.x+b.width>rect.x+rect.width+.1||b.y+b.height>rect.y+rect.height+.1)failures.push({text:t.textContent,b:{x:b.x,y:b.y,w:b.width,h:b.height},rect:{x:rect.x,y:rect.y,w:rect.width,h:rect.height}});if(b.x<0||b.y<0||b.x+b.width>v.width+.1||b.y+b.height>v.height+.1)failures.push('outside viewport');}}return {failures,texts:svg.querySelectorAll('g text').length};})()`);
    results.push({version,x,y,horizontal,label,r});
   }
  }
  fs.writeFileSync('visual-render-result.json',JSON.stringify(results,null,2));
  const failures=results.filter(r=>r.r.failures.length);console.log(JSON.stringify({cases:results.length,failures},null,2));
  win.destroy();app.exit(failures.length?1:0);
 }catch(e){console.error(e.stack);app.exit(1);}
});
