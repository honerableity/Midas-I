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

// Persist Discord <-> Roblox link. Called at the moment role assign succeeds.
// merge:true so re-verifying overwrites cleanly instead of erroring on existing doc.
async function saveVerifiedUser(discordId, { robloxId, robloxUsername, guildId }) {
  await db.collection('verifiedUsers').doc(discordId).set({
    robloxId,
    robloxUsername,
    verifiedAt: Date.now(),
    guildId,
  }, { merge: true });
}

async function getVerifiedUser(discordId) {
  const snap = await db.collection('verifiedUsers').doc(discordId).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function removeVerifiedUser(discordId) {
  await db.collection('verifiedUsers').doc(discordId).delete();
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

// Full profile pull for /verify profile: account info, badges, groups.
// robloxId already known (from verifiedUsers record) so this skips the
// username lookup step that fetchRobloxDescription needs.
async function fetchRobloxProfileDetails(robloxId) {
  const userRes = await fetch(`https://users.roblox.com/v1/users/${robloxId}`);
  if (!userRes.ok) throw new Error(`Roblox user fetch failed: ${userRes.status}`);
  const user = await userRes.json();

  const badgesRes = await fetch(
    `https://badges.roblox.com/v1/users/${robloxId}/badges?limit=100&sortOrder=Desc`
  );
  if (!badgesRes.ok) throw new Error(`Roblox badges fetch failed: ${badgesRes.status}`);
  const badgesData = await badgesRes.json();

  const groupsRes = await fetch(`https://groups.roblox.com/v1/users/${robloxId}/groups/roles`);
  if (!groupsRes.ok) throw new Error(`Roblox groups fetch failed: ${groupsRes.status}`);
  const groupsData = await groupsRes.json();

  return {
    username: user.name,
    displayName: user.displayName,
    created: user.created, // ISO string
    hasVerifiedBadge: user.hasVerifiedBadge,
    badges: badgesData.data ? badgesData.data.map(b => b.name) : [],
    badgeCountIsCapped: badgesData.data ? badgesData.data.length >= 100 : false, // API caps at 100/page; true count may be higher
    groups: groupsData.data
      ? groupsData.data.map(g => ({ name: g.group.name, role: g.role.name }))
      : [],
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
  fetchRobloxProfileDetails,
  descriptionContainsCode,
  saveVerifiedUser,
  getVerifiedUser,
  removeVerifiedUser,
  EXPIRY_MS,
};
