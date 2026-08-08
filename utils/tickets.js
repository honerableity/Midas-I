const { db } = require('./firebase.js');
const { FieldValue } = require('firebase-admin/firestore');

// Ticket doc shape (collection "tickets", doc id = channel id):
// {
//   guildId, channelId, category: 'order'|'service'|'customerservice',
//   creatorId, status: 'open'|'done',
//   products: [{ productId, name, price, qty }],  // order only
//   total: number,                                 // order only
//   serviceAnswer: string,                          // service only
//   ticketNumber: number,
//   createdAt, closedAt,
// }

async function getGuildConfig(guildId) {
  const snap = await db.collection('guildConfig').doc(guildId).get();
  return snap.exists ? snap.data() : {};
}

async function setTestiChannel(guildId, channelId) {
  await db.collection('guildConfig').doc(guildId).set({ testiChannelId: channelId }, { merge: true });
}

async function getTestiChannel(guildId) {
  const cfg = await getGuildConfig(guildId);
  return cfg.testiChannelId || null;
}

// Ticket category channels (created by /ticket createcategory) -- new ticket
// channels get parented under the matching category so they don't clutter
// the channel list root.
async function setTicketCategories(guildId, categoryIds) {
  await db.collection('guildConfig').doc(guildId).set(
    { ticketCategories: categoryIds },
    { merge: true }
  );
}

async function getTicketCategories(guildId) {
  const cfg = await getGuildConfig(guildId);
  return cfg.ticketCategories || null;
}

// Atomic counter for testimonial numbering, per guild. Firestore transaction
// so two /ticket done calls racing each other can't both grab the same number.
async function nextTicketNumber(guildId) {
  const ref = db.collection('guildConfig').doc(guildId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const current = doc.exists ? (doc.data().testiCounter || 0) : 0;
    const next = current + 1;
    tx.set(ref, { testiCounter: next }, { merge: true });
    return next;
  });
}

async function createTicket(data) {
  await db.collection('tickets').doc(data.channelId).set({
    ...data,
    status: 'open',
    createdAt: Date.now(),
  });
}

// Double-click failsafe for ticket creation (order/service/customerservice
// all use this). Discord can dispatch the same button/modal-submit as two
// separate interactions in rare cases (client retry, fast double-tap before
// the button visually disables) -- since each dispatch is a separate
// interaction, deferUpdate alone can't stop both from running the
// create-channel code. Instead we claim a short-lived per-user-per-category
// lock via Firestore transaction: whichever call transacts first wins and
// proceeds, the second sees the lock already held and is told to bail out
// (caller then deletes the channel it already made as a failsafe cleanup).
// Lock auto-expires after LOCK_MS so a crashed first attempt doesn't
// permanently block the user. Keyed by category too, so creating an order
// ticket doesn't block a concurrent service ticket for the same user.
const CREATE_LOCK_MS = 15 * 1000;

async function claimTicketCreateLock(userId, category) {
  const ref = db.collection('ticketCreateLocks').doc(`${userId}_${category}`);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const now = Date.now();
    if (doc.exists && (now - (doc.data().lockedAt || 0)) < CREATE_LOCK_MS) {
      return false; // someone else (or an earlier click) holds the lock
    }
    tx.set(ref, { lockedAt: now });
    return true;
  });
}

async function releaseTicketCreateLock(userId, category) {
  await db.collection('ticketCreateLocks').doc(`${userId}_${category}`).delete().catch(() => {});
}

// Discord customIds cap at 100 chars, and product ids are uuidv4 (36 chars
// each) -- comma-joining more than ~2 product ids into a customId overflows
// that limit. Instead, the order confirm screen's product selection is
// stashed here under a short random token, and the Create-ticket button's
// customId only carries the token. Entries expire after SELECTION_TTL_MS so
// this doesn't accumulate abandoned selections forever.
const SELECTION_TTL_MS = 15 * 60 * 1000;

async function saveOrderSelection(token, userId, productIds) {
  await db.collection('orderSelections').doc(token).set({
    userId,
    productIds,
    createdAt: Date.now(),
  });
}

async function getOrderSelection(token) {
  const doc = await db.collection('orderSelections').doc(token).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (Date.now() - (data.createdAt || 0) > SELECTION_TTL_MS) return null;
  return data;
}

async function getTicket(channelId) {
  const doc = await db.collection('tickets').doc(channelId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// One open ticket per category per user (order/service/customerservice
// checked separately -- a user can have one open order ticket AND one open
// service ticket at the same time, just not two open order tickets).
// Filtering category in JS instead of adding it to the Firestore query
// keeps this to a 2-field equality query (creatorId + status), which
// doesn't need a composite index; a 3-field guildId+creatorId+status query
// would.
async function findOpenTicket(guildId, creatorId, category) {
  const snap = await db.collection('tickets')
    .where('creatorId', '==', creatorId)
    .where('status', '==', 'open')
    .get();

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.guildId === guildId && data.category === category) {
      return { id: doc.id, ...data };
    }
  }
  return null;
}

async function closeTicket(channelId, extra = {}) {
  await db.collection('tickets').doc(channelId).set(
    { status: 'done', closedAt: Date.now(), ...extra },
    { merge: true }
  );
}

// /ticket close deletes the actual Discord channel, so the ticket doc is
// kept (not deleted) as a record -- just flagged. Firestore doc id (channel
// id) staying put also means a re-run of /ticket close on an already-closed
// channel id is harmless/idempotent.
async function markTicketDeleted(channelId) {
  await db.collection('tickets').doc(channelId).set(
    { status: 'deleted', deletedAt: Date.now() },
    { merge: true }
  );
}

module.exports = {
  setTestiChannel,
  getTestiChannel,
  setTicketCategories,
  getTicketCategories,
  nextTicketNumber,
  createTicket,
  getTicket,
  findOpenTicket,
  closeTicket,
  markTicketDeleted,
  claimTicketCreateLock,
  releaseTicketCreateLock,
  saveOrderSelection,
  getOrderSelection,
};
