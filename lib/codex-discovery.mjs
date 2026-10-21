import path from 'node:path';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';

/**
 * Resolve a native Codex CLI without changing global PATH or user credentials.
 * Agent Desk's optional per-user CLI installation is kept outside app resources
 * so in-place patches, uninstallers, or profile backups do not overwrite it.
 */
export function resolveCodexCommand({
  command,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
  home = homedir(),
} = {}) {
  if (typeof command === 'string' && command.trim()) return command;
  if (typeof env.CODEX_BINARY === 'string' && env.CODEX_BINARY.trim()) return env.CODEX_BINARY;
  if (platform !== 'win32') return 'codex';
  const native = arch === 'arm64'
    ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc']
    : arch === 'x64'
      ? ['codex-win32-x64', 'x86_64-pc-windows-msvc']
      : null;
  if (!native) return 'codex';
  const localAppData = env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || home, 'AppData', 'Local');
  const installed = path.win32.join(localAppData, 'AgentDesk', 'codex-cli', 'node_modules', '@openai', native[0], 'vendor', native[1], 'bin', 'codex.exe');
  return exists(installed) ? installed : 'codex';
}
