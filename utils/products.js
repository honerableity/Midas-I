const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { db } = require('./firebase.js');

// Slugify a type name into a Discord-safe channel name (lowercase, dashes,
// alnum only) -- mirrors how Discord itself sanitizes channel names, done
// here explicitly so the stored forum channel is predictable/idempotent.
function slugifyChannelName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'produk';
}

async function getGuildProductConfig(guildId) {
  const snap = await db.collection('guildConfig').doc(guildId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return {
    productCategoryId: data.productCategoryId || null,
  };
}

async function saveProductCategory(guildId, categoryId) {
  await db.collection('guildConfig').doc(guildId).set({ productCategoryId: categoryId }, { merge: true });
}

// Creates the shared "Bot Products" category the first time any product type
// forum is created in a guild. Subsequent createtype calls reuse it. Same
// owner-only-by-default shape as resolveLogCategory in utils/logger.js, but
// a separate category since logs and product forums serve different
// audiences (logs = admin-only always, product forums = admin-post but
// member-can-view once we widen permissions per forum below).
async function resolveProductCategory(guild, guildId) {
  const config = await getGuildProductConfig(guildId);

  if (config?.productCategoryId) {
    const existing = await guild.channels.fetch(config.productCategoryId).catch(() => null);
    if (existing) return existing;
    // Stored id is stale (category deleted manually) -- fall through and create a new one.
  }

  const category = await guild.channels.create({
    name: 'Bot Products',
    type: ChannelType.GuildCategory,
  });

  await saveProductCategory(guildId, category.id);
  return category;
}

// Fetches every registered product type for a guild.
async function listProductTypes(guildId) {
  const snap = await db.collection('productTypes').where('guildId', '==', guildId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getProductTypeByName(guildId, name) {
  const snap = await db
    .collection('productTypes')
    .where('guildId', '==', guildId)
    .where('name', '==', name)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getProductTypeById(typeId) {
  const doc = await db.collection('productTypes').doc(typeId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// Creates (or, if the type name already exists, re-syncs) a forum channel
// dedicated to one product type. Admin-only post/chat permission: @everyone
// can view + read history but cannot send messages or create forum posts;
// the bot itself is allowed to do both so /product sendpost can post there.
// Idempotent by design -- calling this again for the same type name reuses
// the existing forum channel and re-applies the permission overwrites
// instead of creating a duplicate.
async function createOrSyncProductTypeForum(guild, guildId, typeName) {
  const existingType = await getProductTypeByName(guildId, typeName);

  const category = await resolveProductCategory(guild, guildId);

  const everyoneOverwrite = {
    id: guild.roles.everyone.id,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    deny: [
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
    ],
  };
  const botOverwrite = {
    id: guild.client.user.id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.ManageChannels,
    ],
  };

  if (existingType?.forumChannelId) {
    const existingChannel = await guild.channels.fetch(existingType.forumChannelId).catch(() => null);
    if (existingChannel) {
      await existingChannel.permissionOverwrites.set([everyoneOverwrite, botOverwrite]);
      return { type: existingType, forumChannel: existingChannel, created: false };
    }
    // Stored channel id is stale (deleted manually) -- fall through and create a fresh one below.
  }

  const forumChannel = await guild.channels.create({
    name: slugifyChannelName(typeName),
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: `Produk kategori: ${typeName}`,
    permissionOverwrites: [everyoneOverwrite, botOverwrite],
  });

  let typeDoc;
  if (existingType) {
    await db.collection('productTypes').doc(existingType.id).set(
      { forumChannelId: forumChannel.id },
      { merge: true }
    );
    typeDoc = { ...existingType, forumChannelId: forumChannel.id };
  } else {
    const ref = await db.collection('productTypes').add({
      name: typeName,
      guildId,
      forumChannelId: forumChannel.id,
      createdAt: Date.now(),
    });
    typeDoc = { id: ref.id, name: typeName, guildId, forumChannelId: forumChannel.id };
  }

  return { type: typeDoc, forumChannel, created: true };
}

async function getProduct(productId) {
  const doc = await db.collection('products').doc(productId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function saveProduct(productId, data) {
  await db.collection('products').doc(productId).set(data);
}

module.exports = {
  slugifyChannelName,
  resolveProductCategory,
  listProductTypes,
  getProductTypeByName,
  getProductTypeById,
  createOrSyncProductTypeForum,
  getProduct,
  saveProduct,
};
