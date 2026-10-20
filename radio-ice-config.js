'use strict';

const crypto = require('node:crypto');

const STUN_URL = 'stun:stun.l.google.com:19302';
const XIRSYS_ENDPOINT = 'https://global.xirsys.net/_turn/';
const XIRSYS_CREDENTIAL_TTL_SECONDS = 60 * 60;
const PROVIDER_TIMEOUT_MS = 8000;

function stunOnly(turnStatus) {
  return {
    iceServers: [{ urls: STUN_URL }],
    turnStatus
  };
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) return [];
  return value.map((server) => {
    if (!server || typeof server !== 'object') return null;
    const rawUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const urls = rawUrls.filter((url) => typeof url === 'string' && /^(?:stun|turns?):/i.test(url.trim()));
    if (!urls.length) return null;

    const normalized = { urls };
    if (typeof server.username === 'string') normalized.username = server.username;
    if (typeof server.credential === 'string') normalized.credential = server.credential;
    if (typeof server.credentialType === 'string') normalized.credentialType = server.credentialType;
    return normalized;
  }).filter(Boolean);
}

function hasUsableTurnServer(iceServers) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(url)) &&
      typeof server.username === 'string' && server.username.length > 0 &&
      typeof server.credential === 'string' && server.credential.length > 0;
  });
}

function createCoturnConfig(socketId, env, now) {
  const urls = String(env.RADIO_TURN_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^turns?:/i.test(url));
  const sharedSecret = String(env.RADIO_TURN_SHARED_SECRET || '');
  if (!urls.length || !sharedSecret) return null;

  // coturn REST credentials expire after six hours; the shared secret stays server-side.
  const username = `${Math.floor(now() / 1000) + 6 * 60 * 60}:${String(socketId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
  const credential = crypto.createHmac('sha1', sharedSecret).update(username).digest('base64');
  return {
    iceServers: [{ urls: STUN_URL }, { urls, username, credential }],
    turnStatus: 'configured'
  };
}

async function createXirsysConfig(env, fetchImpl) {
  const ident = String(env.XIRSYS_IDENT || '').trim();
  const secret = String(env.XIRSYS_SECRET || '');
  const channel = String(env.XIRSYS_CHANNEL || '').trim();
  if (!ident || !secret || !channel) return null;

  const endpoint = `${XIRSYS_ENDPOINT}${encodeURIComponent(channel)}?webrtc=1&expire=${XIRSYS_CREDENTIAL_TTL_SECONDS}`;
  const authorization = Buffer.from(`${ident}:${secret}`).toString('base64');
  const requestOptions = {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    requestOptions.signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  }
  const response = await fetchImpl(endpoint, requestOptions);
  const data = await response.json();
  if (!response.ok || data?.s !== 'ok') return null;

  const iceServers = normalizeIceServers(data?.v?.iceServers);
  if (!hasUsableTurnServer(iceServers)) return null;
  return { iceServers, turnStatus: 'configured' };
}

async function createRadioIceConfig(socketId, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const coturnConfig = createCoturnConfig(socketId, env, now);
  const xirsysValues = [env.XIRSYS_IDENT, env.XIRSYS_SECRET, env.XIRSYS_CHANNEL];
  const hasAnyXirsysValue = xirsysValues.some((value) => String(value || '').trim() !== '');
  const hasAllXirsysValues = xirsysValues.every((value) => String(value || '').trim() !== '');

  if (hasAnyXirsysValue && !hasAllXirsysValues) {
    return coturnConfig || stunOnly('misconfigured');
  }

  if (hasAllXirsysValues) {
    if (typeof fetchImpl !== 'function') return coturnConfig || stunOnly('provider-error');
    try {
      const xirsysConfig = await createXirsysConfig(env, fetchImpl);
      if (xirsysConfig) return xirsysConfig;
    } catch {
      // The provider's error body can contain sensitive operational details; do not log or return it.
    }
    return coturnConfig || stunOnly('provider-error');
  }

  return coturnConfig || stunOnly('not-configured');
}

module.exports = { createRadioIceConfig };
