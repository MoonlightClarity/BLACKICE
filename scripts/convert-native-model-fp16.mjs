import { constants as fsConstants } from 'node:fs';
import { mkdir, stat, rm, rename, readFile, copyFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSafetensorsModel } from '../lib/native-inference/safetensors.mjs';
import { convertSafetensorsToFP16 } from '../lib/native-inference/convert-fp16.mjs';

export async function convertNativeModelDirectory({ sourceDirectory, outputDirectory, signal } = {}) {
  if (typeof sourceDirectory !== 'string' || !path.isAbsolute(sourceDirectory) ||
      typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory))
    throw new Error('Source and output must be absolute directories.');
  const source = path.resolve(sourceDirectory), destination = path.resolve(outputDirectory);
  if (source.toLowerCase() === destination.toLowerCase() ||
      destination.toLowerCase().startsWith(source.toLowerCase() + path.sep))
    throw new Error('Output must be a separate directory, not inside the source model folder.');
  if (await stat(destination).then(() => true).catch(e => e.code === 'ENOENT' ? false : Promise.reject(e)))
    throw new Error('Destination already exists; choose a new directory.');
  const model = await openSafetensorsModel(source);
  model.release();
  const temp = path.join(path.dirname(destination), '.' + path.basename(destination) + '-' + randomUUID() + '.partial');
  await mkdir(temp, { recursive: false });
  try {
    const converted = await convertSafetensorsToFP16({
      sourceFile: path.join(source, 'model.safetensors'),
      outputFile: path.join(temp, 'model.safetensors'), signal,
    });
    for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'generation_config.json']) {
      const from = path.join(source, name);
      try { await copyFile(from, path.join(temp, name), fsConstants.COPYFILE_EXCL); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    // The source can be F32 or BF16. A copied source config must not falsely
    // describe the output checkpoint as float32 after explicit FP16 conversion.
    const outputConfigPath = path.join(temp, 'config.json');
    const outputConfig = JSON.parse(await readFile(outputConfigPath, 'utf8'));
    outputConfig.torch_dtype = 'float16';
    if (Object.hasOwn(outputConfig, 'dtype')) outputConfig.dtype = 'float16';
    await writeFile(outputConfigPath, JSON.stringify(outputConfig, null, 2) + '\n');
    const manifest = {
      format: 'blackice-fp16-model-v1', createdAt: new Date().toISOString(),
      original: source, sourceDtypes: converted.sourceDtypes,
      dtype: 'F16', sourceSha256: converted.originalSha256, sha256: converted.outputSha256,
      tensorCount: converted.tensorCount, elements: converted.elements,
      outputBytes: converted.outputBytes, overflowCount: converted.overflowCount,
      quantizationRequested: false,
    };
    await writeFile(path.join(temp, 'fp16-conversion.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    signal?.throwIfAborted();
    if (await stat(destination).then(() => true).catch(e => e.code === 'ENOENT' ? false : Promise.reject(e)))
      throw new Error('Destination appeared during conversion; the original output was not overwritten.');
    await rename(temp, destination);
    return { outputDirectory: destination, ...manifest };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

const executed = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executed) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output') {
    console.error('Usage: node scripts/convert-native-model-fp16.mjs --source ABSOLUTE_SOURCE_DIR --output ABSOLUTE_OUTPUT_DIR');
    process.exitCode = 2;
  } else {
    try {
      const result = await convertNativeModelDirectory({ sourceDirectory: args[1], outputDirectory: args[3] });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('FP16 conversion failed: ' + String(error?.message || error));
      process.exitCode = 1;
    }
  }
}
