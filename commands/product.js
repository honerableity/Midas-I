const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const { v4: uuidv4 } = require('uuid');
const { logCommandActivity } = require('../utils/logger.js');
const {
  listProductTypes,
  createOrSyncProductTypeForum,
  getProduct,
  listProductsByType,
  saveProduct,
  deleteProduct,
} = require('../utils/products.js');

// 15 minutes -- long enough for an admin to fill multi-step forms without
// rushing, short enough that a stale button/select doesn't linger forever.
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

// Discord select menus cap at 25 options. If a guild ever registers more
// product types than that, only the first 25 (by Firestore query order) show
// up here -- acceptable for now, revisit with pagination if it becomes a
// real problem.
const MAX_SELECT_OPTIONS = 25;

function requireAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('product')
    .setDescription('Manage shop products')
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription('Create a new product listing')
    )
    .addSubcommand(sub =>
      sub
        .setName('createtype')
        .setDescription('Create (or re-sync) a product type and its dedicated forum channel')
        .addStringOption(opt =>
          opt.setName('nama').setDescription('Nama jenis produk').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('sendpost')
        .setDescription('Post a product to its type\'s forum channel')
        .addStringOption(opt =>
          opt.setName('product_uuid').setDescription('ID produk (UUID)').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('view')
        .setDescription('Browse all products by type')
    )
    .addSubcommand(sub =>
      sub
        .setName('delete')
        .setDescription('Delete a product')
        .addStringOption(opt =>
          opt.setName('product_uuid').setDescription('ID produk (UUID)').setRequired(true)
        )
    ),

  // Read by utils/logger.js -- see verify.js for the same pattern/comment.
  logSchema: {
    subcommands: {
      create: { label: 'Product — Created', fields: ['discordUser', 'productId', 'productName'] },
      createtype: { label: 'Product — Type Created', fields: ['discordUser', 'typeName', 'forumChannel'] },
      sendpost: { label: 'Product — Post Sent', fields: ['discordUser', 'productId', 'forumChannel'] },
      view: { label: 'Product — Browsed', fields: ['discordUser'] },
      delete: { label: 'Product — Deleted', fields: ['discordUser', 'productId', 'productName'] },
    },
  },

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand(true);

    if (sub === 'create') return handleCreate(interaction);
    if (sub === 'createtype') return handleCreateType(interaction);
    if (sub === 'sendpost') return handleSendPost(interaction);
    if (sub === 'view') return handleView(interaction);
    if (sub === 'delete') return handleDelete(interaction);
  },
};

// ---------------------------------------------------------------------------
// /product create
// ---------------------------------------------------------------------------
async function handleCreate(interaction) {
  if (!requireAdmin(interaction)) {
    return interaction.reply({
      content: 'You need **Administrator** permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Modal 1 must be shown as the very first response to this interaction --
  // no awaits before showModal(). Type selection is deliberately NOT in this
  // modal: Discord modals only support text inputs, not select menus, so
  // "Jenis" is picked afterward via a StringSelectMenu once both modals are
  // done (see below).
  const modal1 = new ModalBuilder()
    .setCustomId('product_create_modal_1')
    .setTitle('New Product (1/2)');

  const nameInput = new TextInputBuilder()
    .setCustomId('product_name')
    .setLabel('Nama produk')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const descInput = new TextInputBuilder()
    .setCustomId('product_description')
    .setLabel('Deskripsi')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const priceInput = new TextInputBuilder()
    .setCustomId('product_price')
    .setLabel('Harga')
    .setPlaceholder('cth: 25000 atau Rp25.000')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const creatorInput = new TextInputBuilder()
    .setCustomId('product_creator')
    .setLabel('Kreator (kosongkan jika kamu sendiri)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal1.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(descInput),
    new ActionRowBuilder().addComponents(priceInput),
    new ActionRowBuilder().addComponents(creatorInput),
  );

  await interaction.showModal(modal1);

  let modal1Submit;
  try {
    modal1Submit = await interaction.awaitModalSubmit({
      time: STEP_TIMEOUT_MS,
      filter: (i) => i.customId === 'product_create_modal_1' && i.user.id === interaction.user.id,
    });
  } catch (err) {
    if (err?.code !== 'InteractionCollectorError') {
      console.error('Product create modal 1 submit error:', err);
    }
    return;
  }

  const productName = modal1Submit.fields.getTextInputValue('product_name').trim();
  const productDescription = modal1Submit.fields.getTextInputValue('product_description').trim();
  const productPrice = modal1Submit.fields.getTextInputValue('product_price').trim();
  const productCreatorRaw = modal1Submit.fields.getTextInputValue('product_creator').trim();
  const productCreator = productCreatorRaw || interaction.user.username;

  // Step 2 needs its own modal, chained off a button click -- modal1Submit
  // can't showModal() again after already acking modal 1's submission.
  const continueRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('product_create_continue')
      .setLabel('Lanjutkan (2/2)')
      .setStyle(ButtonStyle.Primary)
  );

  await modal1Submit.reply({
    content: 'Langkah 1 tersimpan. Klik tombol di bawah buat lanjut ke langkah 2.',
    components: [continueRow],
    flags: MessageFlags.Ephemeral,
  });

  let btnInteraction;
  try {
    btnInteraction = await modal1Submit.channel.awaitMessageComponent({
      filter: (i) => i.customId === 'product_create_continue' && i.user.id === interaction.user.id,
      time: STEP_TIMEOUT_MS,
    });
  } catch (err) {
    if (err?.code !== 'InteractionCollectorError') {
      console.error('Product create continue-button error:', err);
    }
    try {
      await modal1Submit.editReply({ content: 'Waktu habis. Jalankan `/product create` lagi.', components: [] });
    } catch {
      // interaction may already be too old to edit
    }
    return;
  }

  const modal2 = new ModalBuilder()
    .setCustomId('product_create_modal_2')
    .setTitle('New Product (2/2)');

  const fileLinkInput = new TextInputBuilder()
    .setCustomId('product_file_link')
    .setLabel('Link file produk')
    .setPlaceholder('CDN Discord, catbox.moe, Drive, Mega.nz, dll')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const reviewMediaInput = new TextInputBuilder()
    .setCustomId('product_review_media')
    .setLabel('Video/Gambar Review Produk')
    .setPlaceholder('Link video atau gambar review')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal2.addComponents(
    new ActionRowBuilder().addComponents(fileLinkInput),
    new ActionRowBuilder().addComponents(reviewMediaInput),
  );

  await btnInteraction.showModal(modal2);

  let modal2Submit;
  try {
    modal2Submit = await btnInteraction.awaitModalSubmit({
      time: STEP_TIMEOUT_MS,
      filter: (i) => i.customId === 'product_create_modal_2' && i.user.id === interaction.user.id,
    });
  } catch (err) {
    if (err?.code !== 'InteractionCollectorError') {
      console.error('Product create modal 2 submit error:', err);
    }
    return;
  }

  const productFileLink = modal2Submit.fields.getTextInputValue('product_file_link').trim();
  const productReviewMedia = modal2Submit.fields.getTextInputValue('product_review_media').trim();

  // Both text-input steps are done. deferReply() then editReply() so we can
  // now show the type select menu (select menus can't live inside a modal).
  await modal2Submit.deferReply({ flags: MessageFlags.Ephemeral });

  const types = await listProductTypes(interaction.guildId);
  if (types.length === 0) {
    return modal2Submit.editReply({
      content: 'Belum ada jenis produk yang terdaftar. Minta admin jalankan `/product createtype` dulu, baru ulangi `/product create`.',
    });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('product_create_type_select')
    .setPlaceholder('Pilih jenis produk')
    .addOptions(
      types.slice(0, MAX_SELECT_OPTIONS).map((t) => ({ label: t.name, value: t.id }))
    );

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

  await modal2Submit.editReply({
    content: 'Terakhir, pilih jenis produk:',
    components: [selectRow],
  });

  let typeSelectInteraction;
  try {
    typeSelectInteraction = await modal2Submit.channel.awaitMessageComponent({
      filter: (i) => i.customId === 'product_create_type_select' && i.user.id === interaction.user.id,
      time: STEP_TIMEOUT_MS,
    });
  } catch (err) {
    if (err?.code !== 'InteractionCollectorError') {
      console.error('Product create type-select error:', err);
    }
    try {
      await modal2Submit.editReply({ content: 'Waktu habis memilih jenis. Jalankan `/product create` lagi.', components: [] });
    } catch {
      // interaction may already be too old to edit
    }
    return;
  }

  const selectedTypeId = typeSelectInteraction.values[0];
  const selectedType = types.find((t) => t.id === selectedTypeId);

  await typeSelectInteraction.deferUpdate();

  const productId = uuidv4();

  const productData = {
    productId,
    name: productName,
    description: productDescription,
    price: productPrice,
    fileLink: productFileLink,
    reviewMedia: productReviewMedia,
    creator: productCreator,
    type: selectedType.name,
    typeId: selectedType.id,
    typeForumId: selectedType.forumChannelId || null,
    createdBy: interaction.user.id,
    guildId: interaction.guildId,
    createdAt: Date.now(),
  };

  try {
    await saveProduct(productId, productData);
  } catch (err) {
    console.error('Failed to save product to Firestore:', err);
    await logCommandActivity(interaction, {
      subcommand: 'create',
      success: false,
      fields: { discordUser: interaction.user, productName },
      note: 'Firestore write failed.',
    });
    return modal2Submit.editReply({ content: 'Gagal menyimpan produk ke database. Coba lagi.', components: [] });
  }

  await logCommandActivity(interaction, {
    subcommand: 'create',
    success: true,
    fields: { discordUser: interaction.user, productId, productName },
  });

  const embed = new EmbedBuilder()
    .setTitle('Produk Berhasil Dibuat')
    .setColor(0x57f287)
    .addFields(
      { name: 'Nama Produk', value: productName },
      { name: 'ID Produk', value: `\`${productId}\`` },
      { name: 'Jenis', value: selectedType.name, inline: true },
      { name: 'Harga', value: productPrice, inline: true },
      { name: 'Kreator', value: productCreator, inline: true },
    );

  return modal2Submit.editReply({ content: 'Produk berhasil dibuat!', embeds: [embed], components: [] });
}

// ---------------------------------------------------------------------------
// /product createtype
// ---------------------------------------------------------------------------
async function handleCreateType(interaction) {
  if (!requireAdmin(interaction)) {
    return interaction.reply({
      content: 'You need **Administrator** permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Defer immediately -- Firestore + channel-creation calls follow, same
  // cold-start guard used throughout the rest of the bot.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const typeName = interaction.options.getString('nama', true).trim();
  if (!typeName) {
    return interaction.editReply({ content: 'Nama jenis tidak boleh kosong.' });
  }

  let result;
  try {
    result = await createOrSyncProductTypeForum(interaction.guild, interaction.guildId, typeName);
  } catch (err) {
    console.error('createOrSyncProductTypeForum failed:', err);
    await logCommandActivity(interaction, {
      subcommand: 'createtype',
      success: false,
      fields: { discordUser: interaction.user, typeName },
      note: 'Forum channel creation/sync failed.',
    });
    return interaction.editReply({ content: 'Bot error saat membuat/menyinkronkan forum jenis produk. Cek permission Manage Channels bot.' });
  }

  await logCommandActivity(interaction, {
    subcommand: 'createtype',
    success: true,
    fields: { discordUser: interaction.user, typeName, forumChannel: result.forumChannel },
  });

  const verb = result.created ? 'dibuat' : 'disinkronkan ulang';
  return interaction.editReply({
    content: `Jenis produk **${typeName}** ${verb}. Forum: ${result.forumChannel}`,
  });
}

// ---------------------------------------------------------------------------
// /product sendpost
// ---------------------------------------------------------------------------
async function handleSendPost(interaction) {
  if (!requireAdmin(interaction)) {
    return interaction.reply({
      content: 'You need **Administrator** permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const productId = interaction.options.getString('product_uuid', true).trim();

  const product = await getProduct(productId);
  if (!product) {
    await logCommandActivity(interaction, {
      subcommand: 'sendpost',
      success: false,
      fields: { discordUser: interaction.user, productId },
      note: 'Product UUID not found.',
    });
    return interaction.editReply({ content: `Produk dengan ID \`${productId}\` tidak ditemukan.` });
  }

  if (!product.typeForumId) {
    await logCommandActivity(interaction, {
      subcommand: 'sendpost',
      success: false,
      fields: { discordUser: interaction.user, productId },
      note: 'Product has no associated forum (type forum missing).',
    });
    return interaction.editReply({ content: `Produk ini belum punya forum jenis yang valid. Jalankan \`/product createtype\` untuk jenis **${product.type}** dulu.` });
  }

  const forumChannel = await interaction.guild.channels.fetch(product.typeForumId).catch(() => null);
  if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
    await logCommandActivity(interaction, {
      subcommand: 'sendpost',
      success: false,
      fields: { discordUser: interaction.user, productId },
      note: 'Forum channel missing or no longer a forum channel.',
    });
    return interaction.editReply({ content: 'Forum untuk jenis produk ini sudah tidak ada. Jalankan `/product createtype` lagi untuk membuatnya ulang.' });
  }

  const embed = new EmbedBuilder()
    .setTitle(product.name)
    .setColor(0x00b0f4)
    .addFields(
      { name: 'Harga', value: product.price, inline: true },
      { name: 'Jenis', value: product.type, inline: true },
      { name: 'Kreator', value: product.creator, inline: true },
      { name: 'Link File', value: product.fileLink },
    );

  // Attach review media as an actual embed image when it looks like a direct
  // image URL; otherwise (video links, non-direct hosts) fall back to a
  // plain link field so we don't render a broken embed.
  const isImageUrl = /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(product.reviewMedia);
  if (isImageUrl) {
    embed.setImage(product.reviewMedia);
  } else {
    embed.addFields({ name: 'Video/Gambar Review', value: product.reviewMedia });
  }

  let thread;
  try {
    thread = await forumChannel.threads.create({
      name: product.name,
      message: {
        content: product.description,
        embeds: [embed],
      },
    });
  } catch (err) {
    console.error('Forum post creation failed:', err);
    await logCommandActivity(interaction, {
      subcommand: 'sendpost',
      success: false,
      fields: { discordUser: interaction.user, productId },
      note: 'Bot error while creating forum post.',
    });
    return interaction.editReply({ content: 'Bot error saat membuat post di forum. Cek permission bot di channel forum tersebut.' });
  }

  await logCommandActivity(interaction, {
    subcommand: 'sendpost',
    success: true,
    fields: { discordUser: interaction.user, productId, forumChannel },
  });

  // Save the created thread id back onto the product so /product delete can
  // clean it up later. Best-effort -- if this write fails, the post itself
  // already succeeded, so we don't fail the command over it.
  try {
    await saveProduct(productId, { ...product, forumThreadId: thread.id });
  } catch (err) {
    console.error('Failed to save forumThreadId onto product (post itself succeeded):', err);
  }

  return interaction.editReply({ content: `Produk **${product.name}** berhasil diposting: ${thread}` });
}

// ---------------------------------------------------------------------------
// /product view
// ---------------------------------------------------------------------------
async function handleView(interaction) {
  // Public catalog browse -- no admin check, non-ephemeral, same visibility
  // rationale as /verify profile.
  await interaction.deferReply();

  const types = await listProductTypes(interaction.guildId);
  types.sort((a, b) => a.name.localeCompare(b.name));

  if (types.length === 0) {
    return interaction.editReply({ content: 'Belum ada jenis produk yang terdaftar.' });
  }

  await logCommandActivity(interaction, {
    subcommand: 'view',
    success: true,
    fields: { discordUser: interaction.user },
  });

  // Products for each type are loaded lazily and cached in this closure as
  // the user browses, so switching types repeatedly doesn't re-query
  // Firestore every time -- only the first visit to each type pays for it.
  const productsByTypeCache = new Map();

  async function getProductsForType(typeIndex) {
    const type = types[typeIndex];
    if (!productsByTypeCache.has(type.id)) {
      const products = await listProductsByType(interaction.guildId, type.id);
      products.sort((a, b) => a.name.localeCompare(b.name));
      productsByTypeCache.set(type.id, products);
    }
    return productsByTypeCache.get(type.id);
  }

  // Pagination state lives in this closure per response -- one browse
  // session, one collector. Switching type always resets productIndex to 0
  // (a product index from one type has no meaning in another).
  const state = { typeIndex: 0, productIndex: 0 };

  async function buildEmbed() {
    const type = types[state.typeIndex];
    const products = await getProductsForType(state.typeIndex);

    const embed = new EmbedBuilder()
      .setColor(0x00b0f4)
      .setFooter({ text: `Jenis ${state.typeIndex + 1}/${types.length} — ${type.name}` });

    if (products.length === 0) {
      embed
        .setTitle(type.name)
        .setDescription('Belum ada produk di jenis ini.');
      return embed;
    }

    const product = products[state.productIndex];

    embed
      .setTitle(product.name)
      .setDescription(product.description)
      .addFields(
        { name: 'Harga', value: product.price, inline: true },
        { name: 'Jenis', value: product.type, inline: true },
        { name: 'Kreator', value: product.creator, inline: true },
        { name: 'ID Produk', value: `\`${product.productId}\`` },
      );

    const isImageUrl = /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(product.reviewMedia || '');
    if (isImageUrl) {
      embed.setImage(product.reviewMedia);
    } else if (product.reviewMedia) {
      embed.addFields({ name: 'Video/Gambar Review', value: product.reviewMedia });
    }

    embed.setFooter({
      text: `Jenis ${state.typeIndex + 1}/${types.length} — ${type.name} · Produk ${state.productIndex + 1}/${products.length}`,
    });

    return embed;
  }

  async function buildComponents(disabled = false) {
    const products = await getProductsForType(state.typeIndex);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('product_view_type_prev')
        .setLabel('◀◀ Jenis')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || types.length <= 1),
      new ButtonBuilder()
        .setCustomId('product_view_product_prev')
        .setLabel('◀ Produk')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || products.length <= 1 || state.productIndex === 0),
      new ButtonBuilder()
        .setCustomId('product_view_product_next')
        .setLabel('Produk ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || products.length <= 1 || state.productIndex >= products.length - 1),
      new ButtonBuilder()
        .setCustomId('product_view_type_next')
        .setLabel('Jenis ▶▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || types.length <= 1),
    );

    return [row];
  }

  const message = await interaction.editReply({ embeds: [await buildEmbed()], components: await buildComponents() });

  const collector = message.createMessageComponentCollector({ time: 10 * 60 * 1000 });

  collector.on('collect', async (btnInteraction) => {
    if (btnInteraction.user.id !== interaction.user.id) {
      return btnInteraction.reply({ content: 'Only the person who ran this command can use these buttons.', flags: MessageFlags.Ephemeral });
    }

    if (btnInteraction.customId === 'product_view_type_prev') {
      state.typeIndex = (state.typeIndex - 1 + types.length) % types.length;
      state.productIndex = 0;
    } else if (btnInteraction.customId === 'product_view_type_next') {
      state.typeIndex = (state.typeIndex + 1) % types.length;
      state.productIndex = 0;
    } else if (btnInteraction.customId === 'product_view_product_prev') {
      state.productIndex = Math.max(0, state.productIndex - 1);
    } else if (btnInteraction.customId === 'product_view_product_next') {
      const products = await getProductsForType(state.typeIndex);
      state.productIndex = Math.min(products.length - 1, state.productIndex + 1);
    }

    await btnInteraction.update({ embeds: [await buildEmbed()], components: await buildComponents() });
  });

  collector.on('end', async () => {
    try {
      await interaction.editReply({ components: await buildComponents(true) });
    } catch {
      // message may have been deleted by then; nothing more to do
    }
  });
}

// ---------------------------------------------------------------------------
// /product delete
// ---------------------------------------------------------------------------
async function handleDelete(interaction) {
  if (!requireAdmin(interaction)) {
    return interaction.reply({
      content: 'You need **Administrator** permission to do that.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const productId = interaction.options.getString('product_uuid', true).trim();

  // showModal() must be the very first response to this interaction -- no
  // Firestore read before it (same cold-start guard as /verify unverify).
  // The "does this product even exist" check happens after the modal is
  // submitted instead, inside modalSubmit's own fresh 15-minute ack window.
  const modal = new ModalBuilder()
    .setCustomId('product_delete_modal')
    .setTitle('Confirm Delete');

  const confirmInput = new TextInputBuilder()
    .setCustomId('confirm_uuid')
    .setLabel('Ketik ulang UUID produk untuk konfirmasi')
    .setPlaceholder(productId)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(confirmInput));
  await interaction.showModal(modal);

  let modalSubmit;
  try {
    modalSubmit = await interaction.awaitModalSubmit({
      time: 2 * 60 * 1000,
      filter: (i) => i.customId === 'product_delete_modal' && i.user.id === interaction.user.id,
    });
  } catch (err) {
    if (err?.code !== 'InteractionCollectorError') {
      console.error('Product delete modal submit error:', err);
    }
    return;
  }

  await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });

  const product = await getProduct(productId);
  if (!product) {
    await logCommandActivity(interaction, {
      subcommand: 'delete',
      success: false,
      fields: { discordUser: interaction.user, productId },
      note: 'Product UUID not found.',
    });
    return modalSubmit.editReply({ content: `Produk dengan ID \`${productId}\` tidak ditemukan.` });
  }

  const typed = modalSubmit.fields.getTextInputValue('confirm_uuid').trim();
  if (typed !== productId) {
    return modalSubmit.editReply({
      content: `UUID tidak cocok. Kamu ketik \`${typed}\`, seharusnya \`${productId}\`. Jalankan \`/product delete\` lagi untuk mengulang.`,
    });
  }

  // Best-effort forum thread cleanup -- a missing channel/thread (already
  // deleted manually, or sendpost was never run for this product) shouldn't
  // block deleting the underlying product record.
  if (product.forumThreadId && product.typeForumId) {
    try {
      const forumChannel = await interaction.guild.channels.fetch(product.typeForumId).catch(() => null);
      if (forumChannel) {
        const thread = await forumChannel.threads.fetch(product.forumThreadId).catch(() => null);
        if (thread) {
          await thread.delete();
        }
      }
    } catch (err) {
      console.error('Failed to delete forum thread during product delete (continuing anyway):', err);
    }
  }

  try {
    await deleteProduct(productId);
  } catch (err) {
    console.error('Failed to delete product from Firestore:', err);
    await logCommandActivity(interaction, {
      subcommand: 'delete',
      success: false,
      fields: { discordUser: interaction.user, productId, productName: product.name },
      note: 'Firestore delete failed.',
    });
    return modalSubmit.editReply({ content: 'Gagal menghapus produk dari database. Coba lagi.' });
  }

  await logCommandActivity(interaction, {
    subcommand: 'delete',
    success: true,
    fields: { discordUser: interaction.user, productId, productName: product.name },
  });

  return modalSubmit.editReply({ content: `Produk **${product.name}** (\`${productId}\`) berhasil dihapus.` });
}
