const { db } = require('./firebase.js');
const { FieldValue } = require('firebase-admin/firestore');

// ---------- duration parsing ----------
// Accepts "10m", "2h", "3d", "1w", or "permanent"/"none"/empty -> null (permanent).
// Returns milliseconds, or null for permanent.
function parseDuration(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (s === 'permanent' || s === 'perm' || s === 'none' || s === '') return null;

  const match = s.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/);
  if (!match) return undefined; // undefined = invalid, caller must distinguish from null

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  if (unit.startsWith('m')) return amount * 60 * 1000;
  if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
  if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
  if (unit.startsWith('w')) return amount * 7 * 24 * 60 * 60 * 1000;
  return undefined;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'permanent';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  return `${weeks}w`;
}

// ---------- guild mod config (setwarn thresholds) ----------
// Structure: guildConfig/{guildId}.warnThresholds = [{ count, action, roleId? }]
async function getWarnThresholds(guildId) {
  const snap = await db.collection('guildConfig').doc(guildId).get();
  return snap.exists ? (snap.data().warnThresholds || []) : [];
}

async function addWarnThreshold(guildId, threshold) {
  const ref = db.collection('guildConfig').doc(guildId);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data().warnThresholds || []) : [];

  // Replace existing rule at same count if present, else append.
  const filtered = existing.filter((t) => t.count !== threshold.count);
  filtered.push(threshold);
  filtered.sort((a, b) => a.count - b.count);

  await ref.set({ warnThresholds: filtered }, { merge: true });
  return filtered;
}

// ---------- warns ----------
// warns/{guildId}_{userId} = { guildId, userId, count, history: [{ moderatorId, reason, timestamp }] }
function warnDocId(guildId, userId) {
  return `${guildId}_${userId}`;
}

async function addWarn(guildId, userId, moderatorId, reason) {
  const ref = db.collection('warns').doc(warnDocId(guildId, userId));
  const entry = { moderatorId, reason: reason || 'No reason provided', timestamp: Date.now() };

  await ref.set(
    {
      guildId,
      userId,
      count: FieldValue.increment(1),
      history: FieldValue.arrayUnion(entry),
    },
    { merge: true }
  );

  const snap = await ref.get();
  return snap.data();
}

async function getWarnCount(guildId, userId) {
  const snap = await db.collection('warns').doc(warnDocId(guildId, userId)).get();
  return snap.exists ? (snap.data().count || 0) : 0;
}

async function resetWarns(guildId, userId) {
  await db.collection('warns').doc(warnDocId(guildId, userId)).set(
    { guildId, userId, count: 0, history: [] },
    { merge: true }
  );
}

// ---------- honeypot config ----------
async function setHoneypotChannel(guildId, channelId) {
  await db.collection('guildConfig').doc(guildId).set({ honeypotChannelId: channelId }, { merge: true });
}

async function getHoneypotChannel(guildId) {
  const snap = await db.collection('guildConfig').doc(guildId).get();
  return snap.exists ? (snap.data().honeypotChannelId || null) : null;
}

// ---------- expiring actions (temp-ban, vcmute) ----------
// expiringActions/{autoId} = { guildId, userId, type: 'ban'|'vcmute', expiresAt, moderatorId }
async function scheduleExpiringAction(guildId, userId, type, expiresAtMs, moderatorId) {
  if (expiresAtMs === null) return; // permanent, nothing to schedule
  await db.collection('expiringActions').add({
    guildId,
    userId,
    type,
    expiresAt: expiresAtMs,
    moderatorId,
    createdAt: Date.now(),
  });
}

// Remove any pending expiring actions of a type for a user (e.g. manual unban/unmute
// before the timer fires, or replacing an old timer when re-banning with a new duration).
async function clearExpiringActions(guildId, userId, type) {
  const snap = await db.collection('expiringActions')
    .where('guildId', '==', guildId)
    .where('userId', '==', userId)
    .where('type', '==', type)
    .get();

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  if (!snap.empty) await batch.commit();
}

async function getDueExpiringActions(nowMs) {
  const snap = await db.collection('expiringActions').where('expiresAt', '<=', nowMs).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function deleteExpiringAction(docId) {
  await db.collection('expiringActions').doc(docId).delete().catch(() => {});
}

// Scans due expiring actions and reverses them (unban / voice-unmute).
// Called on boot and on an interval. Self-contained — only needs the client.
async function runExpiryScan(client) {
  let due;
  try {
    due = await getDueExpiringActions(Date.now());
  } catch (err) {
    console.error('[moderation] runExpiryScan fetch failed:', err);
    return;
  }

  for (const action of due) {
    try {
      const guild = await client.guilds.fetch(action.guildId).catch(() => null);
      if (!guild) {
        await deleteExpiringAction(action.id);
        continue;
      }

      if (action.type === 'ban') {
        await guild.bans.remove(action.userId, 'Temp-ban duration expired').catch(() => {});
      } else if (action.type === 'vcmute') {
        const member = await guild.members.fetch(action.userId).catch(() => null);
        if (member?.voice?.channelId) {
          await member.voice.setMute(false, 'Temp voice-mute duration expired').catch(() => {});
        }
      }

      await deleteExpiringAction(action.id);
    } catch (err) {
      console.error(`[moderation] failed to reverse expiring action ${action.id}:`, err);
      // Leave the doc in place so it retries on the next scan pass instead of
      // silently dropping a stuck ban/mute.
    }
  }
}

function startExpiryScanner(client, intervalMs = 60 * 1000) {
  runExpiryScan(client); // run once immediately on boot to catch anything missed while offline
  setInterval(() => runExpiryScan(client), intervalMs);
}

module.exports = {
  parseDuration,
  formatDuration,
  getWarnThresholds,
  addWarnThreshold,
  addWarn,
  getWarnCount,
  resetWarns,
  setHoneypotChannel,
  getHoneypotChannel,
  scheduleExpiringAction,
  clearExpiringActions,
  startExpiryScanner,
  runExpiryScan,
};
