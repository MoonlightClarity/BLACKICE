import { inspectLocalModelPrerequisites } from '../lib/local-model-prerequisites.mjs';

const [, , bundleRoot, portText = '8080', ...extra] = process.argv;
if (!bundleRoot || bundleRoot === '--help' || extra.length || !/^\d+$/.test(portText)
    || Number(portText) < 1 || Number(portText) > 65535) {
  console.log('Usage: node scripts/inspect-local-model-prerequisites.mjs <bundle-directory> [local-llama-port]');
  if (bundleRoot !== '--help') process.exitCode = 2;
} else {
  const result = await inspectLocalModelPrerequisites({ bundleRoot, port: Number(portText) });
  console.log(JSON.stringify(result, null, 2));
  if (result.models.status !== 'detected' || result.gpu.status !== 'detected') process.exitCode = 1;
}
