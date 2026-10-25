// Electron does not provide the conditional passkey autofill surface advertised
// by Chromium. Correct only that capability; explicit WebAuthn remains native.
// This page-world compatibility script exposes no application or Node APIs.
(function installConditionalPasskeyCapabilities() {
  const credential = globalThis.PublicKeyCredential;
  if (typeof credential !== 'function') return;

  const conditional = Object.getOwnPropertyDescriptor(credential, 'isConditionalMediationAvailable');
  if (typeof conditional?.value === 'function') {
    const replacement = { isConditionalMediationAvailable() { return Promise.resolve(false); } };
    Object.defineProperty(credential, 'isConditionalMediationAvailable', { ...conditional, value: replacement.isConditionalMediationAvailable });
  }

  const capabilities = Object.getOwnPropertyDescriptor(credential, 'getClientCapabilities');
  if (typeof capabilities?.value === 'function') {
    const nativeCapabilities = capabilities.value;
    const replacement = {
      getClientCapabilities(...args) {
        return Reflect.apply(nativeCapabilities, this, args).then(value => ({ ...value, conditionalGet: false }));
      },
    };
    Object.defineProperty(credential, 'getClientCapabilities', { ...capabilities, value: replacement.getClientCapabilities });
  }
})();

// Chromium's DevTools protocol reports a file chooser opened through the File
// System Access API without an input node. That gives a contained client no
// exact DOM target to receive the user's selected bytes, so the native picker
// cannot be completed safely. Translate only an already-supported
// showOpenFilePicker call into a private file input at document start. The
// existing host-side chooser interception can then retain its exact node,
// document and URL guards. This bridge exposes no path or host API to the page.
(function installContainedOpenFilePicker() {
  const nativePicker = globalThis.showOpenFilePicker;
  if (typeof nativePicker !== 'function' || typeof document?.createElement !== 'function') return;

  const ownDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'showOpenFilePicker');
  if (ownDescriptor && (!ownDescriptor.configurable && !ownDescriptor.writable)) return;
  let active = null;
  const abort = () => new DOMException('The user aborted a request.', 'AbortError');
  const denied = () => new DOMException('Writing to a selected local file is not available in this contained browser.', 'NotAllowedError');
  const selectedHandle = file => {
    const prototype = typeof globalThis.FileSystemFileHandle === 'function' ? globalThis.FileSystemFileHandle.prototype : Object.prototype;
    const handle = Object.create(prototype);
    // Native FileSystemHandle prototypes expose getter-only `kind` and `name`
    // accessors. Define exact own values instead of assigning through those
    // inherited accessors, which would throw and leave the picker unresolved.
    Object.defineProperties(handle, {
      kind: { enumerable: true, value: 'file' },
      name: { enumerable: true, value: file.name },
      getFile: { enumerable: true, value: async () => file },
      isSameEntry: { enumerable: true, value: async other => other === handle },
      queryPermission: { enumerable: true, value: async options => options?.mode === 'readwrite' ? 'denied' : 'granted' },
      requestPermission: { enumerable: true, value: async options => options?.mode === 'readwrite' ? 'denied' : 'granted' },
      createWritable: { enumerable: true, value: async () => { throw denied(); } },
      remove: { enumerable: true, value: async () => { throw denied(); } },
    });
    return Object.freeze(handle);
  };

  function acceptValue(options) {
    if (options === undefined) return '';
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('File picker options must be an object.');
    if (options.multiple !== undefined && typeof options.multiple !== 'boolean') throw new TypeError('File picker multiple must be a boolean.');
    if (options.types === undefined) return '';
    if (!Array.isArray(options.types)) throw new TypeError('File picker types must be an array.');
    const accepted = [];
    for (const type of options.types) {
      if (!type || typeof type !== 'object' || !type.accept || typeof type.accept !== 'object' || Array.isArray(type.accept)) throw new TypeError('Each file picker type must contain accepted MIME types.');
      for (const [mime, extensions] of Object.entries(type.accept)) {
        if (typeof mime !== 'string' || !mime || !Array.isArray(extensions) || extensions.some(extension => typeof extension !== 'string' || !extension.startsWith('.') || extension.length < 2)) throw new TypeError('File picker accept entries must contain a MIME type and file extensions.');
        accepted.push(mime, ...extensions);
      }
    }
    return [...new Set(accepted)].join(',');
  }

  function showOpenFilePicker(options) {
    let accept;
    try { accept = acceptValue(options); }
    catch (cause) { return Promise.reject(cause); }
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = options?.multiple === true; input.hidden = true; input.tabIndex = -1;
    input.setAttribute('data-blackice-contained-file-picker', '');
    if (accept) input.accept = accept;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        input.removeEventListener('change', changed);
        input.removeEventListener('cancel', cancelled);
        input.removeEventListener('input', inputChanged);
        input.remove();
        if (active?.input === input) active = null;
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true; cleanup(); callback(value);
      };
      const cancelled = () => settle(reject, abort());
      const inputChanged = () => { if (!input.files?.length) cancelled(); };
      const changed = () => {
        const files = Array.from(input.files || []);
        if (!files.length) { cancelled(); return; }
        settle(resolve, files.map(selectedHandle));
      };
      if (active) active.cancel();
      active = { input, cancel: cancelled };
      input.addEventListener('change', changed);
      input.addEventListener('cancel', cancelled);
      input.addEventListener('input', inputChanged);
      const parent = document.documentElement || document.body;
      if (!parent) { settle(reject, new DOMException('The document is not ready for file selection.', 'InvalidStateError')); return; }
      parent.append(input);
      try { input.click(); }
      catch (cause) { settle(reject, cause); }
    });
  }

  Object.defineProperty(globalThis, 'showOpenFilePicker', {
    configurable: ownDescriptor?.configurable ?? true,
    enumerable: ownDescriptor?.enumerable ?? true,
    writable: ownDescriptor?.writable ?? true,
    value: showOpenFilePicker,
  });
})();
