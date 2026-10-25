    // Disposable-only actual Electron-renderer test. Never shows or focuses a
    // window. The trigger is accepted only with headless + isolated profile.
    if (launch.headless && launch.profileDir && process.env.BLACKICE_NATIVE_EVENT_TEST === '1') {
      const uiTrigger = path.join(app.getPath('userData'), 'hidden-renderer-trigger.txt');
      const uiResult = path.join(app.getPath('userData'), 'hidden-renderer-result.json');
      let probing = false;
      const uiTimer = setInterval(async () => {
        if (probing || shutdownPromise) return;
        probing = true;
        let uiWindow = null;
        try {
          await fs.access(uiTrigger);
          clearInterval(uiTimer);
          await fs.rm(uiTrigger, { force: true });
          const start = Date.now();
          uiWindow = new BrowserWindow({
            width: 1200, height: 820, show: false, focusable: false,
            skipTaskbar: true, frame: false,
            webPreferences: {
              preload: path.join(DESKTOP_DIR, 'preload.cjs'),
              contextIsolation: true, sandbox: true, nodeIntegration: false,
              webSecurity: true, webviewTag: false, spellcheck: false,
            },
          });
          uiWindow.setMenuBarVisibility(false);
          const consoleErrors = [];
          uiWindow.webContents.on('console-message', (...items) => {
            if (String(items[1]?.level || items[1] || '').toLowerCase().includes('error'))
              consoleErrors.push('renderer-console-error');
          });
          const target = local.url + '/next/';
          await uiWindow.loadURL(target);
          const evaluate = expression => uiWindow.webContents.executeJavaScript(expression, true);
          const ready = async (expression, label, timeoutMs = 12000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (await evaluate(expression)) return true;
              await new Promise(resolve => setTimeout(resolve, 85));
            }
            throw new Error('Hidden renderer ' + label + ' did not initialize.');
          };
          await ready('Boolean(document.querySelector("#next-chat-new") && document.querySelector("#next-chat-input"))','chat');
          const bootstrapGone = await evaluate('document.querySelector("#next-stage > .next-loading") === null');
          const readerMode = await evaluate('document.querySelector("#next-chat").dataset.reader');
          const chatHeight = await evaluate('Math.round(document.querySelector(".next-chat").getBoundingClientRect().height)');
          const initialMs = Date.now() - start;
          const heavyHistory = process.env.BLACKICE_DISPOSABLE_HEAVY === 'yes';
          let historyTurnCount = 0, historyLoadMs = 0, editorInputMs = 0;
          if (heavyHistory) {
            await ready('Boolean(document.querySelector(".next-conversation"))','saved-conversation-list',30000);
            const familyStart = Date.now();
            await evaluate('document.querySelector(".next-conversation").click(); true');
            const inputStart = Date.now();
            await evaluate('(()=>{const input=document.querySelector("#next-chat-input"); input.value="Invisible desktop draft"; input.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
            editorInputMs = Date.now() - inputStart;
            await ready('document.querySelectorAll(".next-chat-turn").length === 12','large-history-window',45000);
            historyTurnCount = await evaluate('document.querySelectorAll(".next-chat-turn").length');
            historyLoadMs = Date.now() - familyStart;
          } else {
            await evaluate('(()=>{const input=document.querySelector("#next-chat-input"); input.value="Invisible desktop draft"; input.dispatchEvent(new Event("input",{bubbles:true})); return true;})()');
          }
          await new Promise(resolve => setTimeout(resolve, 350));
          const sections = [
            ['planning','#next-planning-list'],
            ['tasks','#next-tasks-form'],
            ['browser','#next-browser-url'],
            ['settings','#next-settings-model'],
            ['activity','#next-activity-runtime'],
          ];
          const visited = [];
          let browserNavigationMinimum = false;
          for (const [space, selector] of sections) {
            await evaluate('document.querySelector(".next-tab[data-space=' + "'" + space + "'" + ']").click(); true');
            await ready('Boolean(document.querySelector("' + selector + '"))',space);
            visited.push(space);
            if(space === 'browser') {
              uiWindow.setSize(780,560,false);
              await new Promise(resolve => setTimeout(resolve, 180));
              const geometry = await evaluate('(()=>{const nav=document.querySelector("#next-browser-navigation"),address=document.querySelector("#next-browser-url"),tabs=document.querySelector("#next-browser-tabs");if(!nav||!address||!tabs)return null;const b=nav.getBoundingClientRect(),r=address.getBoundingClientRect(),t=tabs.getBoundingClientRect();return {navTop:b.top,navBottom:b.bottom,addressWidth:r.width,addressBottom:r.bottom,tabBottom:t.bottom,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===address};})()');
              await evaluate('document.querySelector("[data-workspace=browser] .next-panel").scrollTop=10000;true');
              await new Promise(resolve => setTimeout(resolve, 110));
              const scrolled = await evaluate('(()=>{const nav=document.querySelector("#next-browser-navigation"),address=document.querySelector("#next-browser-url");const b=nav.getBoundingClientRect(),r=address.getBoundingClientRect();return {navTop:b.top,addressBottom:r.bottom,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===address};})()');
              browserNavigationMinimum = Boolean(geometry&&scrolled&&geometry.navTop>=0&&
                geometry.navBottom<=560&&geometry.addressWidth>=150&&geometry.addressBottom<=560&&
                geometry.tabBottom<=560&&geometry.hit&&scrolled.navTop>=0&&
                scrolled.addressBottom<=560&&scrolled.hit&&!uiWindow.isFocused());
              if(!browserNavigationMinimum)throw Error('Conventional navigation is hidden or unreachable at 780×560.');
              uiWindow.setSize(1200,820,false);
            }
            if (uiWindow.isVisible()) throw new Error('Hidden renderer became visible in ' + space);
          }
          await evaluate('document.querySelector(".next-tab[data-space=chat]").click(); true');
          await ready('Boolean(document.querySelector("#next-chat-input"))','chat-return');
          const draftRetained = await evaluate('document.querySelector("#next-chat-input").value === "Invisible desktop draft"');
          const first=await evaluate('document.querySelector(".next-tab[aria-selected=true]")?.dataset.space');
          const hiddenChat = uiWindow.isVisible() === false;
          const unfocused = uiWindow.isFocused() === false;
          await fs.writeFile(uiResult, JSON.stringify({
            initialized: true, bootstrapGone, readerMode, chatHeight, initialMs,
            visited, draftRetained, selectedSpace:first, hiddenChat, unfocused,
            historyTurnCount, historyLoadMs, editorInputMs,browserNavigationMinimum,
            consoleErrorCount: consoleErrors.length,
          }));
        } catch (error) {
          if (error?.code === 'ENOENT') return; // Trigger has not been created yet.
          clearInterval(uiTimer);
          await fs.writeFile(uiResult,JSON.stringify({error:String(error?.message||error)})).catch(()=>{});
        } finally {
          try { if (uiWindow && !uiWindow.isDestroyed()) uiWindow.destroy(); } catch {}
          probing = false;
        }
      }, 140);
      uiTimer.unref();
    }
