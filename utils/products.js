const { ChannelType, PermissionFlagsBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { FieldValue } = require('firebase-admin/firestore');
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
function buildForumPermissionOverwrites(guild) {
  return [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
      ],
    },
    {
      id: guild.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];
}

async function createOrSyncProductTypeForum(guild, guildId, typeName) {
  const existingType = await getProductTypeByName(guildId, typeName);

  const category = await resolveProductCategory(guild, guildId);
  const overwrites = buildForumPermissionOverwrites(guild);

  if (existingType?.forumChannelId) {
    const existingChannel = await guild.channels.fetch(existingType.forumChannelId).catch(() => null);
    if (existingChannel) {
      await existingChannel.permissionOverwrites.set(overwrites);
      return { type: existingType, forumChannel: existingChannel, created: false };
    }
    // Stored channel id is stale (deleted manually) -- fall through and create a fresh one below.
  }

  const forumChannel = await guild.channels.create({
    name: slugifyChannelName(typeName),
    type: ChannelType.GuildForum,
    parent: category.id,
    topic: `Produk kategori: ${typeName}`,
    permissionOverwrites: overwrites,
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

// Links a product type to an ALREADY-EXISTING forum channel instead of
// creating a new one -- for admins who already made the channel by hand (or
// want to reuse one from a restructure) and just want the bot to register it
// as a jenis. Caller (handleLinkType) validates the channel is a GuildForum
// before calling this; this function just re-applies the same admin-post /
// member-view permission overwrites createOrSyncProductTypeForum uses, so a
// linked channel behaves identically to a bot-created one from then on
// (e.g. /product sendpost works the same either way).
async function linkExistingForumToType(guild, guildId, typeName, forumChannel) {
  const existingType = await getProductTypeByName(guildId, typeName);
  const overwrites = buildForumPermissionOverwrites(guild);

  await forumChannel.permissionOverwrites.set(overwrites);

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

  return { type: typeDoc, forumChannel, wasExistingType: !!existingType };
}

async function getProduct(productId) {
  const doc = await db.collection('products').doc(productId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// Fetches every product belonging to one type, for a guild. Used by
// /product view's product-level Prev/Next pagination.
async function listProductsByType(guildId, typeId) {
  const snap = await db
    .collection('products')
    .where('guildId', '==', guildId)
    .where('typeId', '==', typeId)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function saveProduct(productId, data) {
  await db.collection('products').doc(productId).set(data);
}

async function deleteProduct(productId) {
  await db.collection('products').doc(productId).delete();
}

// Ownership stored on both sides (owners[] on the product doc, ownedProducts[]
// on the verifiedUsers doc) so either can be queried directly without a join
// -- mirrors the array-field decision made for this feature (no separate
// ownership collection). arrayUnion/arrayRemove are atomic and no-op safely
// if run twice, but callers still pre-check membership so /product give and
// /product revoke can report "already owns" / "doesn't own" instead of
// silently succeeding on a no-op.
function userOwnsProduct(product, discordId) {
  return Array.isArray(product.owners) && product.owners.includes(discordId);
}

async function giveProductToUser(productId, discordId) {
  const batch = db.batch();
  batch.set(
    db.collection('products').doc(productId),
    { owners: FieldValue.arrayUnion(discordId) },
    { merge: true }
  );
  batch.set(
    db.collection('verifiedUsers').doc(discordId),
    { ownedProducts: FieldValue.arrayUnion(productId) },
    { merge: true }
  );
  await batch.commit();
}

async function revokeProductFromUser(productId, discordId) {
  const batch = db.batch();
  batch.set(
    db.collection('products').doc(productId),
    { owners: FieldValue.arrayRemove(discordId) },
    { merge: true }
  );
  batch.set(
    db.collection('verifiedUsers').doc(discordId),
    { ownedProducts: FieldValue.arrayRemove(productId) },
    { merge: true }
  );
  await batch.commit();
}

// Fetches multiple products by id in one round trip. Used by /verify profile's
// "Owned Products" tab, where ownedProducts[] on the verifiedUsers doc can
// exceed Firestore's 30-item `in` query cap -- db.getAll() has no such limit,
// it just batches individual doc reads. Missing/deleted product ids (owned
// but since removed from the catalog) are silently skipped rather than
// erroring, since a stale id shouldn't break the whole list.
async function getProductsByIds(productIds) {
  if (!productIds || productIds.length === 0) return [];
  const refs = productIds.map((id) => db.collection('products').doc(id));
  const docs = await db.getAll(...refs);
  return docs
    .filter((d) => d.exists)
    .map((d) => ({ id: d.id, ...d.data() }));
}

// Builds the DM payload used to deliver a purchased/owned product to a user
// -- shared by /product get and /ticket done so both send the exact same
// embed+button format. tutorialLink is optional; when blank the tutorial
// line is skipped entirely rather than shown as "N/A".
//
// The Download button is a Link-style button, which requires a valid
// http(s) URL. If fileLink isn't one (bad data, non-URL string), Discord
// would throw on .setURL() -- fall back to a plain text field showing the
// link instead of letting the whole send blow up.
function buildProductDeliveryDM(product) {
  const embed = new EmbedBuilder()
    .setTitle(product.name)
    .setColor(0x00b0f4)
    .setDescription('Here is your product, click the button below to download the file.');

  const components = [];
  const row = new ActionRowBuilder();
  let buttonOk = true;

  try {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Download')
        .setStyle(ButtonStyle.Link)
        .setURL(product.fileLink)
    );
  } catch {
    buttonOk = false;
  }

  if (product.tutorialLink) {
    embed.addFields({ name: 'Tutorial', value: product.tutorialLink });
  }

  if (buttonOk) {
    components.push(row);
  } else {
    // fileLink wasn't a valid URL for a Link button -- show it as text.
    embed.addFields({ name: 'Link File', value: product.fileLink });
  }

  return { embeds: [embed], components };
}

module.exports = {
  slugifyChannelName,
  resolveProductCategory,
  listProductTypes,
  getProductTypeByName,
  getProductTypeById,
  createOrSyncProductTypeForum,
  linkExistingForumToType,
  getProduct,
  listProductsByType,
  saveProduct,
  deleteProduct,
  userOwnsProduct,
  giveProductToUser,
  revokeProductFromUser,
  getProductsByIds,
  buildProductDeliveryDM,
};
