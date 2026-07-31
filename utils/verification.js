const crypto = require('crypto');
const words = require('../data/words.js');
const { db } = require('./firebase.js');

const CODE_LENGTH = 5;
const EXPIRY_MS = 15 * 60 * 1000; // 15 min

function genCode() {
  const picked = [];
  const pool = [...words];
  for (let i = 0; i < CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1); // no repeat word in same code
  }
  return picked.join('-');
}

async function createSession(discordId) {
  const code = genCode();
  const expiresAt = Date.now() + EXPIRY_MS;
  await db.collection('verifications').doc(discordId).set({
    code,
    expiresAt,
    createdAt: Date.now(),
  });
  return { code, expiresAt };
}

async function getSession(discordId) {
  const snap = await db.collection('verifications').doc(discordId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (Date.now() > data.expiresAt) {
    await clearSession(discordId); // lazy cleanup of stale docs
    return null;
  }
  return data;
}

async function clearSession(discordId) {
  await db.collection('verifications').doc(discordId).delete();
}

async function getGuildConfig(guildId) {
  const snap = await db.collection('guildConfig').doc(guildId).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function setGuildRole(guildId, roleId) {
  await db.collection('guildConfig').doc(guildId).set({ verifiedRoleId: roleId }, { merge: true });
}

// Fetches Roblox user id from username, then their profile description (blurb).
async function fetchRobloxDescription(username) {
  const userRes = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!userRes.ok) throw new Error(`Roblox user lookup failed: ${userRes.status}`);
  const userData = await userRes.json();
  if (!userData.data || userData.data.length === 0) return { notFound: true };

  const robloxId = userData.data[0].id;

  const profileRes = await fetch(`https://users.roblox.com/v1/users/${robloxId}`);
  if (!profileRes.ok) throw new Error(`Roblox profile fetch failed: ${profileRes.status}`);
  const profileData = await profileRes.json();

  return {
    notFound: false,
    robloxId,
    robloxUsername: profileData.name,
    description: profileData.description || '',
  };
}

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // strip zero-width chars
    .replace(/[\s-]+/g, ''); // collapse spaces/dashes so "pearl - opal" still matches "pearl-opal"
}

function descriptionContainsCode(description, code) {
  return normalize(description).includes(normalize(code));
}

module.exports = {
  genCode,
  createSession,
  getSession,
  clearSession,
  getGuildConfig,
  setGuildRole,
  fetchRobloxDescription,
  descriptionContainsCode,
  EXPIRY_MS,
};
