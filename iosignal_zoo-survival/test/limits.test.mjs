// Server limits are off unless the operator sets them (game-kit serverLimitsFromEnv, iosignal 10.3.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startZoo } from '../src/zoo-server.mjs';
import { serverLimitsFromEnv } from '../../game-kit/server.mjs';

test('no environment: no limits', () => {
  assert.deepEqual(serverLimitsFromEnv({}), {});
});

test('IOSIGNAL_ANON_LIMITS and IOSIGNAL_CONNECTION_LIMITS become Server options', () => {
  const options = serverLimitsFromEnv({ IOSIGNAL_ANON_LIMITS: 'msgPerSec=100, maxMessageBytes=262144', IOSIGNAL_CONNECTION_LIMITS: 'maxPerAddress=200' });
  assert.deepEqual(options, { quotas: { anonymous: { msgPerSec: 100, maxMessageBytes: 262144 } }, anonymousQuota: 'anonymous', connectionLimits: { maxPerAddress: 200 } });
  assert.throws(() => serverLimitsFromEnv({ IOSIGNAL_ANON_LIMITS: 'msgPerSec=fast' }), /IOSIGNAL_ANON_LIMITS/);
});

test('the zoo server applies the limits it is given, and none by default', async () => {
  const plain = await startZoo({ port: 0, congPort: 0, log: () => {}, dashboard: false });
  const limited = await startZoo({ port: 0, congPort: 0, log: () => {}, dashboard: false,
    serverOptions: serverLimitsFromEnv({ IOSIGNAL_ANON_LIMITS: 'msgPerSec=100', IOSIGNAL_CONNECTION_LIMITS: 'maxPerAddress=200' }) });
  try {
    assert.equal(plain.ioServer.anonymousQuota, null);
    assert.equal(limited.ioServer.anonymousQuota, 'anonymous');
    assert.equal(limited.ioServer.quotas.anonymous.msgPerSec, 100);
    assert.equal(limited.ioServer.connectionLimits.maxPerAddress, 200);
  } finally {
    await plain.close();
    await limited.close();
  }
});
