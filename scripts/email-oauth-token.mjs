// Invoked only by BLACKICE's generated Himalaya configuration. The parent gives
// this process one short-lived token; persistent credentials stay in Electron.
const value = process.env.BLACKICE_EMAIL_ACCESS_TOKEN;
delete process.env.BLACKICE_EMAIL_ACCESS_TOKEN;
if (typeof value !== 'string' || !value || value.length > 65536 || !/^[\x21-\x7e]+$/.test(value)) {
  process.stderr.write('BLACKICE email authorization is unavailable. Reconnect from Settings.\n');
  process.exitCode = 1;
} else {
  process.stdout.write(value);
}
