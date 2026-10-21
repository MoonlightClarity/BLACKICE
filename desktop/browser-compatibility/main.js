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
