import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { launchAgentPlist } from '../src/deploy/launchd.ts';

describe('launchAgentPlist', () => {
  test('starts the service at login from the project, restarts it only after a crash, logs in data/logs', () => {
    const plist = launchAgentPlist({ node: '/opt/node/bin/node', projectRoot: '/Users/me/dev/A&B' });
    assert.match(plist, /<string>local\.copilote-x<\/string>/);
    assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>\n\s+<string>--env-file=\.env<\/string>\n\s+<string>src\/cli\/start\.ts<\/string>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>\n\s+<string>\/Users\/me\/dev\/A&amp;B<\/string>/);
    assert.match(plist, /<key>SuccessfulExit<\/key>\n\s+<false\/>/);
    assert.match(plist, /<string>\/Users\/me\/dev\/A&amp;B\/data\/logs\/service\.error\.log<\/string>/);
  });
});
