import path from 'node:path';

/** Neutral name of the launch agent: it says nothing about the account. */
export const LAUNCHD_LABEL = 'local.copilote-x';

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The launch agent: starts the service at login, restarts it after a crash (not after a clean stop),
 * at most once a minute, with its output in data/logs.
 */
export function launchAgentPlist(options: { label?: string; node: string; projectRoot: string }): string {
  const label = options.label ?? LAUNCHD_LABEL;
  const logs = path.join(options.projectRoot, 'data', 'logs');
  const args = [options.node, '--env-file=.env', 'src/cli/start.ts'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logs, 'service.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logs, 'service.error.log'))}</string>
</dict>
</plist>
`;
}
