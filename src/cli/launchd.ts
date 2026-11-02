import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.ts';
import { LAUNCHD_LABEL, launchAgentPlist } from '../deploy/launchd.ts';

// Automatic start on the Mac: npm run mac:install | mac:uninstall | mac:status.
// The Mac and a VPS must never run together: one bot, one instance (see the README runbook).

const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const domain = `gui/${process.getuid?.() ?? 501}`;

function launchctl(args: string[], allowFailure = false): string {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFailure) return '';
    throw new Error(`launchctl ${args.join(' ')} : ${((error as { stderr?: string }).stderr ?? (error as Error).message).trim()}`);
  }
}

function loaded(): boolean {
  return launchctl(['print', `${domain}/${LAUNCHD_LABEL}`], true) !== '';
}

/** Stops the running agent and waits until launchd has let it go (the bot takes a moment to stop polling). */
function unload(): void {
  if (!loaded()) return;
  launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`], true);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; loaded() && waited < 30_000; waited += 500) Atomics.wait(pause, 0, 0, 500);
  if (loaded()) throw new Error('The service is still running after 30 s: try again in a moment.');
}

const action = process.argv[2];

if (process.platform !== 'darwin') {
  console.error('These commands are for macOS. On a server, use the systemd service described in the README.');
  process.exit(1);
}

if (action === 'install') {
  if (!existsSync(path.join(PROJECT_ROOT, '.env'))) {
    console.error('.env is missing: fill it in before installing the automatic start.');
    process.exit(1);
  }
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.join(PROJECT_ROOT, 'data', 'logs'), { recursive: true });
  unload();
  writeFileSync(plistPath, launchAgentPlist({ node: process.execPath, projectRoot: PROJECT_ROOT }));
  launchctl(['bootstrap', domain, plistPath]);
  console.log(`Automatic start installed (${plistPath}).`);
  console.log(`Node used: ${process.execPath}. After a Node update, run npm run mac:install again.`);
  console.log('Journaux : data/logs/service.log et data/logs/service.error.log.');
} else if (action === 'uninstall') {
  unload();
  rmSync(plistPath, { force: true });
  console.log('Automatic start removed, service stopped.');
} else if (action === 'status') {
  if (!loaded()) {
    console.log(existsSync(plistPath) ? 'Installed but not loaded.' : 'Automatic start not installed.');
  } else {
    const info = launchctl(['print', `${domain}/${LAUNCHD_LABEL}`]);
    const state = /^\s*state = (.+)$/m.exec(info)?.[1] ?? 'inconnu';
    const pid = /^\s*pid = (\d+)$/m.exec(info)?.[1];
    console.log(`Loaded: ${state}${pid ? `, PID ${pid}` : ''}.`);
  }
} else {
  console.error('Usage : npm run mac:install | mac:uninstall | mac:status');
  process.exit(1);
}
