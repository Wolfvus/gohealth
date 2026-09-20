import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('OAuth server binds loopback and rejects invalid callbacks without storing tokens', async () => {
  const originalCwd = process.cwd();
  const originalCredentials = process.env.GOOGLE_HEALTH_CREDENTIALS;
  const directory = await mkdtemp(join(tmpdir(), 'gohealth-auth-test-'));
  let server;
  try {
    process.chdir(directory);
    process.env.GOOGLE_HEALTH_CREDENTIALS = join(directory, 'client.json');
    await writeFile(process.env.GOOGLE_HEALTH_CREDENTIALS, JSON.stringify({ web: {
      client_id: 'test-client', client_secret: 'test-only-not-a-real-secret',
      redirect_uris: ['http://localhost:3000/oauth2/callback']
    } }), { mode: 0o600 });
    const { startAuthorizationServer } = await import('../dist/server.js');
    server = await startAuthorizationServer(0);
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    const origin = `http://127.0.0.1:${address.port}`;
    const authorization = await fetch(`${origin}/auth`, { redirect: 'manual' });
    assert.equal(authorization.status, 302);
    const state = new URL(authorization.headers.get('location')).searchParams.get('state');
    assert.match(state, /^[a-f0-9]{64}$/);
    for (const query of ['', '?code=test', `?code=test&state=${'0'.repeat(64)}`, `?state=${state}`]) {
      const response = await fetch(`${origin}/oauth2/callback${query}`);
      assert.equal(response.status, 400);
    }
    await assert.rejects(access(join(directory, '.secrets/google-health-tokens.json')));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    process.chdir(originalCwd);
    if (originalCredentials === undefined) delete process.env.GOOGLE_HEALTH_CREDENTIALS;
    else process.env.GOOGLE_HEALTH_CREDENTIALS = originalCredentials;
    await rm(directory, { recursive: true, force: true });
  }
});
