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

const action = process.argv[2];

if (process.platform !== 'darwin') {
  console.error('Ces commandes visent macOS. Sur un VPS, utilise le service systemd décrit dans le README.');
  process.exit(1);
}

if (action === 'install') {
  if (!existsSync(path.join(PROJECT_ROOT, '.env'))) {
    console.error('.env absent : remplis-le avant d’installer le lancement automatique.');
    process.exit(1);
  }
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.join(PROJECT_ROOT, 'data', 'logs'), { recursive: true });
  if (loaded()) launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`], true);
  writeFileSync(plistPath, launchAgentPlist({ node: process.execPath, projectRoot: PROJECT_ROOT }));
  launchctl(['bootstrap', domain, plistPath]);
  console.log(`Lancement automatique installé (${plistPath}).`);
  console.log(`Node utilisé : ${process.execPath}. Après une mise à jour de Node, relance npm run mac:install.`);
  console.log('Journaux : data/logs/service.log et data/logs/service.error.log.');
} else if (action === 'uninstall') {
  if (loaded()) launchctl(['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  rmSync(plistPath, { force: true });
  console.log('Lancement automatique retiré, service arrêté.');
} else if (action === 'status') {
  if (!loaded()) {
    console.log(existsSync(plistPath) ? 'Installé mais pas chargé.' : 'Lancement automatique non installé.');
  } else {
    const info = launchctl(['print', `${domain}/${LAUNCHD_LABEL}`]);
    const state = /^\s*state = (.+)$/m.exec(info)?.[1] ?? 'inconnu';
    const pid = /^\s*pid = (\d+)$/m.exec(info)?.[1];
    console.log(`Chargé : ${state}${pid ? `, PID ${pid}` : ''}.`);
  }
} else {
  console.error('Usage : npm run mac:install | mac:uninstall | mac:status');
  process.exit(1);
}
