'use strict';

const crypto = require('node:crypto');

const SOCIAL_ACCOUNT_LIMIT = 10;
const DISCORD_ID_PATTERN = /^\d{15,22}$/;

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizePlatformName(value) {
  return clean(value, 50)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function normalizeProfileUrl(value) {
  const text = clean(value, 500);
  let url;
  try {
    url = new URL(text);
  } catch (_error) {
    throw new Error('أدخل رابط حساب صالحاً يبدأ بـ https:// أو http://.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('يجب أن يكون رابط الحساب خارجياً وآمناً.');
  }

  url.hash = '';
  return url.toString();
}

function manualAccountIdentity(account) {
  try {
    const url = new URL(normalizeProfileUrl(account?.profileUrl));
    return `manual:${url.origin.toLocaleLowerCase('en-US')}${url.pathname.replace(/\/+$/, '').toLocaleLowerCase('en-US')}`;
  } catch (_error) {
    return '';
  }
}

function accountIdentity(account) {
  if (account?.provider === 'discord' && DISCORD_ID_PATTERN.test(clean(account.externalId, 22))) {
    return `discord:${account.externalId}`;
  }
  if (account?.provider === 'manual') return manualAccountIdentity(account);
  return '';
}

function normalizeDiscordAccount(account) {
  const externalId = clean(account.externalId, 22);
  if (!DISCORD_ID_PATTERN.test(externalId) || account.verificationMethod !== 'oauth2') return null;

  const avatarHash = clean(account.avatarHash, 128);
  const avatarUrl = avatarHash && /^[A-Za-z0-9_-]{1,128}$/.test(avatarHash)
    ? `https://cdn.discordapp.com/avatars/${externalId}/${encodeURIComponent(avatarHash)}.png?size=96`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(externalId) >> 22n) % 6n)}.png`;
  const username = clean(account.username, 100);
  if (!username) return null;

  return {
    id: `discord:${externalId}`,
    provider: 'discord',
    platform: 'Discord',
    externalId,
    username,
    profileUrl: `https://discord.com/users/${externalId}`,
    avatarHash: avatarHash && /^[A-Za-z0-9_-]{1,128}$/.test(avatarHash) ? avatarHash : '',
    avatarUrl,
    verified: true,
    verificationMethod: 'oauth2',
    linkedAt: clean(account.linkedAt, 40) || null
  };
}

function normalizeManualAccount(account) {
  const platform = clean(account.platform, 50).normalize('NFKC').replace(/\s+/g, ' ');
  const platformKey = normalizePlatformName(platform);
  const username = clean(account.username, 100);
  if (!platform || !platformKey || platformKey === 'discord' || !username) return null;

  let profileUrl;
  try {
    profileUrl = normalizeProfileUrl(account.profileUrl);
  } catch (_error) {
    return null;
  }
  let hostname = '';
  try {
    hostname = new URL(profileUrl).hostname.toLocaleLowerCase('en-US');
  } catch (_error) {}
  if (hostname === 'discord.com' || hostname.endsWith('.discord.com') || hostname === 'discordapp.com' || hostname.endsWith('.discordapp.com')) {
    return null;
  }

  const id = clean(account.id, 160) || `manual-${crypto.createHash('sha256').update(`${platformKey}\n${profileUrl}`).digest('hex').slice(0, 32)}`;
  return {
    id,
    provider: 'manual',
    platform,
    username,
    profileUrl,
    avatarUrl: '',
    verified: false,
    verificationMethod: 'manual',
    linkedAt: clean(account.linkedAt, 40) || null
  };
}

function normalizeSocialAccounts(value) {
  const result = [];
  const seenIds = new Set();
  const seenPlatforms = new Set();
  const seenIdentities = new Set();

  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const account = raw.provider === 'discord'
      ? normalizeDiscordAccount(raw)
      : raw.provider === 'manual'
        ? normalizeManualAccount(raw)
        : null;
    if (!account || seenIds.has(account.id)) continue;

    const identity = accountIdentity(account);
    const platform = account.provider === 'manual'
      ? `manual:${normalizePlatformName(account.platform)}`
      : 'discord';
    if (!identity || seenIdentities.has(identity) || seenPlatforms.has(platform)) continue;

    seenIds.add(account.id);
    seenIdentities.add(identity);
    seenPlatforms.add(platform);
    result.push(account);
    if (result.length >= SOCIAL_ACCOUNT_LIMIT) break;
  }

  return result;
}

function createManualSocialAccount(input, linkedAt = new Date().toISOString()) {
  const platform = clean(input?.platform, 50).normalize('NFKC').replace(/\s+/g, ' ');
  const platformKey = normalizePlatformName(platform);
  const username = clean(input?.username, 100);
  if (!platform || !platformKey) throw new Error('أدخل اسم المنصة.');
  if (platformKey === 'discord') throw new Error('اربط Discord عبر تسجيل الدخول الرسمي، وليس كمنصة يدوية.');
  if (!username) throw new Error('أدخل اسم المستخدم.');
  const profileUrl = normalizeProfileUrl(input?.profileUrl);
  const hostname = new URL(profileUrl).hostname.toLocaleLowerCase('en-US');
  if (hostname === 'discord.com' || hostname.endsWith('.discord.com') || hostname === 'discordapp.com' || hostname.endsWith('.discordapp.com')) {
    throw new Error('يجب ربط Discord عبر تسجيل الدخول الرسمي.');
  }

  return {
    id: `manual-${crypto.randomBytes(16).toString('hex')}`,
    provider: 'manual',
    platform,
    username,
    profileUrl,
    avatarUrl: '',
    verified: false,
    verificationMethod: 'manual',
    linkedAt: clean(linkedAt, 40) || new Date().toISOString()
  };
}

function createDiscordSocialAccount(profile, linkedAt = new Date().toISOString()) {
  const externalId = clean(profile?.id, 22);
  const username = clean(profile?.global_name || profile?.username, 100);
  if (!DISCORD_ID_PATTERN.test(externalId) || !username) {
    throw new Error('لم يرسل Discord هوية صالحة للحساب.');
  }
  return normalizeDiscordAccount({
    provider: 'discord',
    externalId,
    username,
    avatarHash: profile.avatar,
    verificationMethod: 'oauth2',
    linkedAt
  });
}

function upsertSocialAccount(current, candidate) {
  const accounts = normalizeSocialAccounts(current);
  const index = accounts.findIndex((account) =>
    account.provider === candidate.provider &&
    (candidate.provider === 'discord' ||
      normalizePlatformName(account.platform) === normalizePlatformName(candidate.platform))
  );
  if (index >= 0) {
    accounts[index] = {
      ...candidate,
      id: accounts[index].id,
      linkedAt: accounts[index].linkedAt || candidate.linkedAt
    };
    return normalizeSocialAccounts(accounts);
  }
  if (accounts.length >= SOCIAL_ACCOUNT_LIMIT) throw new Error('وصلت إلى الحد الأقصى للحسابات الاجتماعية المرتبطة.');
  return normalizeSocialAccounts([...accounts, candidate]);
}

function findDuplicateSocialAccountOwner(users, account, excludingUserId) {
  const identity = accountIdentity(account);
  if (!identity) return null;
  for (const user of Array.isArray(users) ? users : []) {
    if (!user || String(user.id) === String(excludingUserId)) continue;
    if (normalizeSocialAccounts(user.socialAccounts).some((existing) => accountIdentity(existing) === identity)) {
      return user;
    }
  }
  return null;
}

module.exports = {
  SOCIAL_ACCOUNT_LIMIT,
  accountIdentity,
  normalizePlatformName,
  normalizeProfileUrl,
  normalizeSocialAccounts,
  createManualSocialAccount,
  createDiscordSocialAccount,
  upsertSocialAccount,
  findDuplicateSocialAccountOwner
};
