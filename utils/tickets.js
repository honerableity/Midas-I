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

async function getTicket(channelId) {
  const doc = await db.collection('tickets').doc(channelId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function closeTicket(channelId, extra = {}) {
  await db.collection('tickets').doc(channelId).set(
    { status: 'done', closedAt: Date.now(), ...extra },
    { merge: true }
  );
}

module.exports = {
  setTestiChannel,
  getTestiChannel,
  nextTicketNumber,
  createTicket,
  getTicket,
  closeTicket,
};
