    // Disposable-package-only test hook. Never included in branch sources,
    // and requires a custom profile plus headless mode to be enabled.
    if (launch.headless && launch.profileDir && process.env.BLACKICE_NATIVE_EVENT_TEST === '1') {
      const trigger = path.join(app.getPath('userData'), 'native-cleanup-trigger.txt');
      const result = path.join(app.getPath('userData'), 'native-cleanup-result.json');
      let checking = false;
      const interval = setInterval(async () => {
        if (checking || shutdownPromise) return;
        checking = true;
        try {
          await fs.access(trigger);
          const driver = harness.browser?.driver?.drivers?.relay;
          const tab = [...(driver?.tabs?.values() || [])].find(value => value.window && !value.window.isDestroyed());
          if (!tab) return;
          clearInterval(interval);
          await fs.rm(trigger, { force: true });
          const nativeWindow = tab.window;
          // Inspect the real page-world File System Access bridge without
          // clicking it or opening any native file-selection dialog.
          let pickerBridge = false, pickerNoNodeExposure = false;
          for (let attempt = 0; attempt < 20 && !pickerBridge; attempt++) {
            try {
              const probe = await nativeWindow.webContents.executeJavaScript(
                '({present:typeof showOpenFilePicker==="function",bridge:typeof showOpenFilePicker==="function"&&Function.prototype.toString.call(showOpenFilePicker).includes("data-blackice-contained-file-picker"),noNode:typeof require==="undefined"&&typeof process==="undefined"})',
                true);
              pickerBridge = probe?.bridge === true;
              pickerNoNodeExposure = probe?.noNode === true;
            } catch {}
            if (!pickerBridge) await new Promise(resolve => setTimeout(resolve, 180));
          }
          nativeWindow.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -2147483645 });
          const aliveInCallback = !nativeWindow.isDestroyed();
          const detachedInCallback = tab.window === null;
          await new Promise(resolve => setTimeout(resolve, 140));
          await fs.writeFile(result, JSON.stringify({
            aliveInCallback, detachedInCallback,
            destroyedAfterCallback: nativeWindow.isDestroyed(),
            tabPreserved: driver.tabs.get(tab.id) === tab,
            reason: tab.rendererFailure?.reason || 'unknown',
            pickerBridge, pickerNoNodeExposure,
            noNativeFocus: !mainWindow,
          }));
        } catch (error) {
          if (error.code !== 'ENOENT') {
            clearInterval(interval);
            await fs.writeFile(result, JSON.stringify({ error: error.message })).catch(() => {});
          }
        } finally { checking = false; }
      }, 150);
      interval.unref();
    }
