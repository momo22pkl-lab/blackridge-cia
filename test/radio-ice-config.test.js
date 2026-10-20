'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRadioIceConfig } = require('../radio-ice-config');

test('uses STUN only when no TURN provider is configured', async () => {
  const config = await createRadioIceConfig('socket-1', { env: {} });
  assert.deepEqual(config, {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    turnStatus: 'not-configured'
  });
});

test('keeps coturn shared-secret configuration compatible', async () => {
  const now = () => 1_800_000_000_000;
  const config = await createRadioIceConfig('socket-1', {
    env: {
      RADIO_TURN_URLS: 'turn:relay.example:3478,https://invalid.example',
      RADIO_TURN_SHARED_SECRET: 'test-only-shared-secret'
    },
    now
  });
  const username = `${Math.floor(now() / 1000) + 6 * 60 * 60}:socket-1`;
  const credential = crypto.createHmac('sha1', 'test-only-shared-secret').update(username).digest('base64');
  assert.equal(config.turnStatus, 'configured');
  assert.deepEqual(config.iceServers[1], {
    urls: ['turn:relay.example:3478'],
    username,
    credential
  });
});

test('requests temporary Xirsys ICE servers only from the server', async () => {
  let request;
  const config = await createRadioIceConfig('socket-2', {
    env: {
      XIRSYS_IDENT: 'test-ident',
      XIRSYS_SECRET: 'test-secret',
      XIRSYS_CHANNEL: 'black ridge'
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          s: 'ok',
          v: {
            iceServers: [
              { urls: ['stun:stun.example:3478'] },
              { urls: ['turns:relay.example:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-password' }
            ]
          }
        })
      };
    }
  });
  assert.equal(request.url, 'https://global.xirsys.net/_turn/black%20ridge?webrtc=1&expire=3600');
  assert.equal(request.options.method, 'PUT');
  assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from('test-ident:test-secret').toString('base64')}`);
  assert.equal(config.turnStatus, 'configured');
  assert.equal(config.iceServers.length, 2);
  assert.equal(config.iceServers[1].username, 'temporary-user');
});

test('falls back safely when Xirsys cannot issue ICE credentials', async () => {
  const config = await createRadioIceConfig('socket-3', {
    env: {
      XIRSYS_IDENT: 'test-ident',
      XIRSYS_SECRET: 'test-secret',
      XIRSYS_CHANNEL: 'blackridge-cia'
    },
    fetchImpl: async () => { throw new Error('sensitive test error'); }
  });
  assert.deepEqual(config, {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    turnStatus: 'provider-error'
  });
});

test('does not treat a partial Xirsys setup as usable TURN', async () => {
  const config = await createRadioIceConfig('socket-4', {
    env: { XIRSYS_IDENT: 'test-ident' }
  });
  assert.equal(config.turnStatus, 'misconfigured');
  assert.deepEqual(config.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
});
