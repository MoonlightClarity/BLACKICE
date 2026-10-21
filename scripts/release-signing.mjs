import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const executeFile = promisify(execFile);
export async function publicSigningConfiguration(environment = process.env, { readFile = fs.readFile } = {}) {
  const publisher = String(environment.RELAY_SIGNING_PUBLISHER || '').trim(), sha1 = String(environment.RELAY_SIGNING_CERT_SHA1 || '').replaceAll(' ', '');
  const missing = [], errors = [];
  if (!publisher) missing.push('RELAY_SIGNING_PUBLISHER');
  if (publisher.length > 200 || /[\r\n\x00]/.test(publisher)) errors.push('The signing publisher must be one exact certificate common name.');
  if (sha1 && !/^[a-f\d]{40}$/i.test(sha1)) errors.push('RELAY_SIGNING_CERT_SHA1 must be a 40-character certificate thumbprint.');
  let azure = null;
  if (environment.RELAY_AZURE_SIGNING_CONFIG) {
    try {
      const source = JSON.parse(await readFile(environment.RELAY_AZURE_SIGNING_CONFIG, 'utf8'));
      const required = ['publisherName', 'endpoint', 'certificateProfileName', 'codeSigningAccountName'];
      if (required.some(key => typeof source[key] !== 'string' || !source[key].trim()) || source.publisherName !== publisher || !/^https:\/\//.test(source.endpoint)) throw Error();
      azure = Object.fromEntries(['publisherName', 'endpoint', 'certificateProfileName', 'codeSigningAccountName', 'fileDigest', 'timestampRfc3161', 'timestampDigest'].filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
    } catch { errors.push('The Azure signing configuration is unreadable, incomplete, or has a different publisher.'); }
  }
  const certificate = Boolean(environment.WIN_CSC_LINK || environment.CSC_LINK || sha1 || environment.RELAY_AZURE_SIGNING_CONFIG);
  const requested = ['RELAY_SIGNING_PUBLISHER','RELAY_SIGNING_CERT_SHA1','WIN_CSC_LINK','CSC_LINK','RELAY_AZURE_SIGNING_CONFIG','WIN_CSC_KEY_PASSWORD','CSC_KEY_PASSWORD'].some(key => Boolean(environment[key]));
  if (!certificate) missing.push('WIN_CSC_LINK, CSC_LINK, RELAY_SIGNING_CERT_SHA1, or RELAY_AZURE_SIGNING_CONFIG');
  const configured = !missing.length && !errors.length;
  return {
    configured, requested, publisher, missing, errors, method: azure ? 'azure' : sha1 ? 'certificate-store' : certificate ? 'pfx' : null,
    builder: configured ? { forceCodeSigning: true, win: { signExecutable: true, signAndEditExecutable: true, verifyUpdateCodeSignature: true, ...(azure ? { azureSignOptions: azure } : { signtoolOptions: { publisherName: publisher, signingHashAlgorithms: ['sha256'], ...(sha1 ? { certificateSha1: sha1 } : {}) } }) } } : null,
  };
}

export function publicBuilderConfiguration(signing, { source, output, requireCodeSigning = false }) {
  if (!signing?.configured && (requireCodeSigning || signing?.requested || signing?.errors?.length)) throw Error(`Signing was requested but its explicit publisher and certificate configuration is incomplete or invalid. ${[...(signing?.missing || []),...(signing?.errors || [])].join(' ')}`);
  const builder = signing?.configured ? signing.builder : {forceCodeSigning:false,win:{signExecutable:false,signAndEditExecutable:true,verifyUpdateCodeSignature:false}};
  return { extends:path.join(source,'desktop/electron-builder.yml'), ...builder, directories:{output}, artifactName:'Blackice-${version}-Setup.${ext}', win:{...builder.win,target:[{target:'nsis',arch:['x64']}]}, nsis:{oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:false,createDesktopShortcut:true,shortcutName:'BLACKICE',deleteAppDataOnUninstall:false} };
}

export async function verifyPublisherSignature(file, publisher, { platform = process.platform, execute = executeFile } = {}) {
  if (!publisher) return { valid: false, status: 'MissingPublisher', error: 'A publisher identity must be supplied.' };
  if (platform !== 'win32') return { valid: false, status: 'UnsupportedPlatform', error: 'Publisher trust must be verified on Windows.' };
  try {
    const script = fileURLToPath(new URL('./verify-publisher.ps1', import.meta.url));
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', script, '-Path', path.resolve(file), '-Publisher', publisher], { windowsHide: true, timeout: 30000, maxBuffer: 32768 });
    const value = JSON.parse(result.stdout.trim());
    return { valid: value.valid === true && value.status === 'Valid' && value.publisher === publisher, status: value.status || 'Unknown', publisher: value.publisher || null, thumbprint: value.thumbprint || null, productVersion: value.productVersion || null };
  } catch { return { valid: false, status: 'VerificationFailed', error: 'Windows could not verify the artifact signature and publisher.' }; }
}
