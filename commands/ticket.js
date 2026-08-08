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
const { listProductTypes, listProductsByType, getProduct, giveProductToUser } = require('../utils/products.js');
const { getVerifiedUser } = require('../utils/verification.js');
const {
  setTestiChannel,
  getTestiChannel,
  setTicketCategories,
  getTicketCategories,
  nextTicketNumber,
  createTicket,
  getTicket,
  closeTicket,
  markTicketDeleted,
  claimOrderCreateLock,
  releaseOrderCreateLock,
  saveOrderSelection,
  getOrderSelection,
} = require('../utils/tickets.js');

const MAX_SELECT_OPTIONS = 25;

// customId prefixes -- routed from index.js's global component handler since
// the panel embed and its buttons/selects outlive the /ticket send command's
// own interaction lifetime (people click days later, after a bot restart).
const CID = {
  PANEL_CATEGORY_SELECT: 'ticket_panel_category',
  ORDER_PRODUCT_SELECT: 'ticket_order_products',
  ORDER_CREATE_BTN: 'ticket_order_create', // ticket_order_create_{selectionToken}
  SERVICE_OPEN_MODAL_BTN: 'ticket_service_open_modal',
  SERVICE_MODAL: 'ticket_service_modal',
  CS_CREATE_BTN: 'ticket_cs_create',
  DONE_MODAL: 'ticket_done_modal', // ticket_done_modal_{channelId}
};

function requireAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function requireAdminReply(interaction) {
  return interaction.reply({
    content: 'You need **Administrator** permission to do that.',
    flags: MessageFlags.Ephemeral,
  });
}

function formatIDR(n) {
  return `Rp${Number(n).toLocaleString('id-ID')}`;
}

// Product price is stored as free-text (see /product create -- "cth: 25000
// atau Rp25.000"), so pull digits out to get a summable number. Falls back
// to 0 if the string has no digits at all rather than throwing, so a weird
// price string degrades the total instead of crashing ticket creation.
function parsePrice(priceStr) {
  const digits = String(priceStr).replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket system')
    .addSubcommand(sub =>
      sub
        .setName('send')
        .setDescription('Send a ticket panel embed')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Where to send the panel').setRequired(true).addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('done')
        .setDescription('Mark the current ticket as done and post testimonial')
    )
    .addSubcommand(sub =>
      sub
        .setName('settesti')
        .setDescription('Set the testimonial channel')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Testimonial channel').setRequired(true).addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('createcategory')
        .setDescription('Create the Order/Service/Customer Service ticket categories')
    )
    .addSubcommand(sub =>
      sub
        .setName('close')
        .setDescription('Close and delete a ticket, DM the creator')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Ticket channel to close').setRequired(true).addChannelTypes(ChannelType.GuildText)
        )
    ),

  logSchema: {
    subcommands: {
      send: { label: 'Ticket — Panel Sent', fields: ['discordUser', 'channel'] },
      done: { label: 'Ticket — Closed', fields: ['discordUser', 'ticketChannel', 'total'] },
      settesti: { label: 'Ticket — Testimonial Channel Set', fields: ['discordUser', 'channel'] },
      createcategory: { label: 'Ticket — Categories Created', fields: ['discordUser'] },
      close: { label: 'Ticket — Deleted', fields: ['discordUser', 'ticketChannel'] },
    },
  },

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand(true);

    if (sub === 'send') return handleSend(interaction);
    if (sub === 'done') return handleDone(interaction);
    if (sub === 'settesti') return handleSetTesti(interaction);
    if (sub === 'createcategory') return handleCreateCategory(interaction);
    if (sub === 'close') return handleClose(interaction);
  },

  // Called from index.js's global interactionCreate router for any
  // button/select/modal customId starting with "ticket_". Keeping this
  // dispatch table here (not in index.js) so all ticket logic stays in one
  // file, same as how product.js/verify.js self-contain their flows.
  async handleComponent(interaction) {
    const id = interaction.customId;

    if (id === CID.PANEL_CATEGORY_SELECT) return onPanelCategorySelect(interaction);
    if (id === CID.ORDER_PRODUCT_SELECT) return onOrderProductSelect(interaction);
    if (id.startsWith(`${CID.ORDER_CREATE_BTN}_`)) return onOrderCreateButton(interaction);
    if (id === CID.SERVICE_OPEN_MODAL_BTN) return onServiceOpenModalButton(interaction);
    if (id === CID.SERVICE_MODAL) return onServiceModalSubmit(interaction);
    if (id === CID.CS_CREATE_BTN) return onCsCreateButton(interaction);
  },
};

// ---------------------------------------------------------------------------
// /ticket send
// ---------------------------------------------------------------------------
async function handleSend(interaction) {
  if (!requireAdmin(interaction)) return requireAdminReply(interaction);

  const targetChannel = interaction.options.getChannel('channel', true);

  const botMember = interaction.guild.members.me;
  const perms = targetChannel.permissionsFor(botMember);
  if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.ViewChannel)) {
    return interaction.reply({
      content: `I can't send messages in ${targetChannel}. Check my permissions there.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('ticket_send_modal')
    .setTitle('Ticket Panel');

  const titleInput = new TextInputBuilder()
    .setCustomId('panel_title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const descInput = new TextInputBuilder()
    .setCustomId('panel_description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const colorInput = new TextInputBuilder()
    .setCustomId('panel_color')
    .setLabel('Color (hex, e.g. #5865F2)')
    .setPlaceholder('#5865F2')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(descInput),
    new ActionRowBuilder().addComponents(colorInput),
  );

  await interaction.showModal(modal);

  let modalSubmit;
  try {
    modalSubmit = await interaction.awaitModalSubmit({
      time: 15 * 60 * 1000,
      filter: (i) => i.customId === 'ticket_send_modal' && i.user.id === interaction.user.id,
    });
  } catch (err) {
    if (err?.code !== 'InteractionCollectorError') console.error('Ticket send modal error:', err);
    return;
  }

  const panelTitle = modalSubmit.fields.getTextInputValue('panel_title').trim();
  const panelDesc = modalSubmit.fields.getTextInputValue('panel_description').trim();
  const colorRaw = modalSubmit.fields.getTextInputValue('panel_color').trim();

  // Ack the modal submit immediately -- it has its own 3s window separate
  // from the earlier showModal(). targetChannel.send() below is a network
  // call and can push past that window, which is what caused the 10062
  // "Unknown interaction" errors.
  await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });

  let color = 0x5865f2;
  if (colorRaw) {
    const parsed = parseInt(colorRaw.replace('#', ''), 16);
    if (!Number.isNaN(parsed)) color = parsed;
  }

  const embed = new EmbedBuilder()
    .setTitle(panelTitle)
    .setDescription(panelDesc)
    .setColor(color);

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId(CID.PANEL_CATEGORY_SELECT)
    .setPlaceholder('Select a ticket category')
    .addOptions(
      { label: 'Order', value: 'order', description: 'Buy a product' },
      { label: 'Service', value: 'service', description: 'Request a service' },
      { label: 'Customer Service', value: 'customerservice', description: 'Talk to an admin' },
    );

  const row = new ActionRowBuilder().addComponents(categorySelect);

  try {
    await targetChannel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Failed to send ticket panel:', err);
    return modalSubmit.editReply({ content: `Couldn't send the panel to ${targetChannel}.` });
  }

  await modalSubmit.editReply({ content: `Panel sent to ${targetChannel}.` });

  await logCommandActivity(interaction, {
    subcommand: 'send',
    success: true,
    fields: { discordUser: interaction.user, channel: targetChannel },
  });
}

// ---------------------------------------------------------------------------
// /ticket settesti
// ---------------------------------------------------------------------------
async function handleSetTesti(interaction) {
  if (!requireAdmin(interaction)) return requireAdminReply(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.options.getChannel('channel', true);
  await setTestiChannel(interaction.guildId, channel.id);

  await logCommandActivity(interaction, {
    subcommand: 'settesti',
    success: true,
    fields: { discordUser: interaction.user, channel },
  });

  return interaction.editReply({ content: `Testimonial channel set to ${channel}.` });
}

// ---------------------------------------------------------------------------
// /ticket createcategory
// ---------------------------------------------------------------------------
async function handleCreateCategory(interaction) {
  if (!requireAdmin(interaction)) return requireAdminReply(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const existing = await getTicketCategories(interaction.guildId);

  // Re-running the command shouldn't duplicate categories -- reuse any that
  // still exist, only create the missing ones.
  const wanted = {
    order: 'Order Tickets',
    service: 'Service Tickets',
    customerservice: 'Customer Service Tickets',
  };

  const result = { ...(existing || {}) };

  for (const [key, name] of Object.entries(wanted)) {
    const stillExists = result[key] && guild.channels.cache.has(result[key]);
    if (stillExists) continue;

    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
    });
    result[key] = created.id;
  }

  await setTicketCategories(interaction.guildId, result);

  await logCommandActivity(interaction, {
    subcommand: 'createcategory',
    success: true,
    fields: { discordUser: interaction.user },
  });

  return interaction.editReply({
    content: `Ticket categories ready:\nOrder: <#${result.order}>\nService: <#${result.service}>\nCustomer Service: <#${result.customerservice}>`,
  });
}

// ---------------------------------------------------------------------------
// /ticket close
// ---------------------------------------------------------------------------
async function handleClose(interaction) {
  if (!requireAdmin(interaction)) return requireAdminReply(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const targetChannel = interaction.options.getChannel('channel', true);

  const ticket = await getTicket(targetChannel.id);
  if (!ticket) {
    return interaction.editReply({ content: `${targetChannel} is not a ticket channel.` });
  }

  // DM before delete -- once the channel's gone there's no fallback path to
  // notify the creator, so this has to happen first even though it means a
  // DM could succeed right before the delete fails (rare, and delete
  // failing is loud/obvious to the admin either way).
  const creator = await interaction.client.users.fetch(ticket.creatorId).catch(() => null);
  let dmSent = false;
  if (creator) {
    try {
      await creator.send(`Your ticket in **${interaction.guild.name}** has been closed.`);
      dmSent = true;
    } catch {
      // DMs closed/blocked -- not fatal, ticket still closes.
    }
  }

  await markTicketDeleted(targetChannel.id);

  try {
    await targetChannel.delete(`Ticket closed by ${interaction.user.tag}`);
  } catch (err) {
    console.error('Failed to delete ticket channel:', err);
    return interaction.editReply({ content: `Couldn't delete ${targetChannel}. Check my permissions there.` });
  }

  await logCommandActivity(interaction, {
    subcommand: 'close',
    success: true,
    fields: { discordUser: interaction.user, ticketChannel: `<#${targetChannel.id}>` },
  });

  return interaction.editReply({
    content: `Ticket closed and deleted.${dmSent ? '' : ' (Could not DM the creator — DMs may be closed.)'}`,
  });
}

// ---------------------------------------------------------------------------
// Ticket channel creation helper -- admin-only visibility (creator +
// Administrator-permission roles can view). Shared by order/service/cs.
// ---------------------------------------------------------------------------
async function createTicketChannel(interaction, category, label) {
  const guild = interaction.guild;

  const adminRoles = guild.roles.cache.filter((r) => r.permissions.has(PermissionFlagsBits.Administrator));

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: guild.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
    },
    ...adminRoles.map((role) => ({
      id: role.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    })),
  ];

  const channelName = `${category}-${interaction.user.username}`.slice(0, 90);

  const categories = await getTicketCategories(interaction.guildId);
  const parentId = categories?.[category] || null;
  // Verify the stored category channel still exists before using it as a
  // parent -- an admin may have deleted it manually since /ticket
  // createcategory ran, and passing a stale id throws on channel create.
  const parentValid = parentId ? guild.channels.cache.has(parentId) : false;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: parentValid ? parentId : undefined,
    permissionOverwrites: overwrites,
    topic: `${label} ticket for ${interaction.user.tag}`,
  });

  return channel;
}

// ===========================================================================
// ORDER FLOW
// ===========================================================================

// Selecting the "Order" panel category -> show a product multi-select
// grouped across all types (flattened, capped at 25 -- Discord's select
// option limit). No quantity step: these are one-off developer products, so
// picking a product in the multi-select is the whole cart -- straight to
// "Create ticket" after selection.
async function onPanelCategorySelect(interaction) {
  const category = interaction.values[0];

  if (category === 'order') {
    // Ack immediately -- Firestore reads below (listProductTypes /
    // listProductsByType loop, verified-user lookup) can push past the 3s
    // interaction window, same cold-start trap as modals. deferReply first,
    // editReply after.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const types = await listProductTypes(interaction.guildId);
    if (types.length === 0) {
      return interaction.editReply({ content: 'No products are available right now.' });
    }

    let allProducts = [];
    for (const type of types) {
      const products = await listProductsByType(interaction.guildId, type.id);
      allProducts = allProducts.concat(products);
    }

    if (allProducts.length === 0) {
      return interaction.editReply({ content: 'No products are available right now.' });
    }

    // Filter out products the user already owns -- they buy each product
    // once (no quantity), so an owned product has nothing left to sell them.
    const verifiedUser = await getVerifiedUser(interaction.user.id);
    const owned = new Set(verifiedUser?.ownedProducts || []);
    const purchasable = allProducts.filter((p) => !owned.has(p.id));

    if (purchasable.length === 0) {
      return interaction.editReply({ content: 'You already own every available product.' });
    }

    const options = purchasable.slice(0, MAX_SELECT_OPTIONS).map((p) => ({
      label: p.name.slice(0, 100),
      description: `${p.type} — ${p.price}`.slice(0, 100),
      value: p.id,
    }));

    const select = new StringSelectMenuBuilder()
      .setCustomId(CID.ORDER_PRODUCT_SELECT)
      .setPlaceholder('Select product(s) to buy')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options);

    return interaction.editReply({
      content: 'Pick the product(s) you want to buy (already-owned products are hidden):',
      components: [new ActionRowBuilder().addComponents(select)],
    });
  }

  if (category === 'service') {
    const btn = new ButtonBuilder()
      .setCustomId(CID.SERVICE_OPEN_MODAL_BTN)
      .setLabel('Fill service request')
      .setStyle(ButtonStyle.Primary);

    return interaction.reply({
      content: 'Click below to describe the service you need:',
      components: [new ActionRowBuilder().addComponents(btn)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (category === 'customerservice') {
    const btn = new ButtonBuilder()
      .setCustomId(CID.CS_CREATE_BTN)
      .setLabel('Create ticket')
      .setStyle(ButtonStyle.Primary);

    return interaction.reply({
      content: 'Click below to open a customer service ticket:',
      components: [new ActionRowBuilder().addComponents(btn)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function loadProductsMap(productIds) {
  const map = new Map();
  for (const id of productIds) {
    const p = await getProduct(id);
    if (p) map.set(id, p);
  }
  return map;
}

// Product multi-select submit -> straight to a confirm screen (no qty step,
// see module header). Selected product ids are round-tripped via the
// Create-ticket button's customId itself rather than re-derived from the
// message, since there's no per-item state left to encode after dropping qty.
async function onOrderProductSelect(interaction) {
  // deferUpdate acks the select-menu click immediately -- loadProductsMap
  // below is a Firestore loop and can push past the 3s window otherwise.
  await interaction.deferUpdate();

  const productIds = interaction.values;
  const productsMap = await loadProductsMap(productIds);
  const validIds = productIds.filter((id) => productsMap.has(id));

  if (validIds.length === 0) {
    return interaction.editReply({ content: 'Selected product(s) no longer exist. Try again.', components: [] });
  }

  const summaryLines = validIds.map((id) => {
    const p = productsMap.get(id);
    return `**${p.name}** — ${p.price}`;
  });

  const total = validIds.reduce((sum, id) => sum + parsePrice(productsMap.get(id).price), 0);

  const token = uuidv4();
  await saveOrderSelection(token, interaction.user.id, validIds);

  const createBtn = new ButtonBuilder()
    .setCustomId(`${CID.ORDER_CREATE_BTN}_${token}`)
    .setLabel('Create ticket')
    .setStyle(ButtonStyle.Success);

  return interaction.editReply({
    content: `${summaryLines.join('\n')}\n\n**Total: ${formatIDR(total)}**`,
    components: [new ActionRowBuilder().addComponents(createBtn)],
  });
}

// "Create ticket" on the order confirm screen -> creates the channel, sums
// total, writes the ticket doc, posts a summary embed inside the new
// channel.
//
// Double-click failsafe: Discord can occasionally dispatch the same button
// press as two separate interactions (client retry / fast double-tap
// landing before the button visually disables). deferUpdate() on both
// wouldn't stop the second one from still running channel-creation code
// after it. Instead we take a short-lived per-user lock in Firestore
// (claimOrderCreateLock) -- the first call to win the transaction proceeds
// normally; a second concurrent call sees the lock held, still has to
// create *a* channel (interaction already committed to it by the time we'd
// know), but immediately deletes that duplicate and tells the user to use
// the first ticket instead.
async function onOrderCreateButton(interaction) {
  await interaction.deferUpdate();

  const token = interaction.customId.replace(`${CID.ORDER_CREATE_BTN}_`, '');
  const selection = await getOrderSelection(token);

  if (!selection || selection.userId !== interaction.user.id) {
    return interaction.editReply({ content: 'This selection has expired. Please start over from the ticket panel.', components: [] });
  }

  const productIds = selection.productIds;

  const gotLock = await claimOrderCreateLock(interaction.user.id);

  const productsMap = await loadProductsMap(productIds);
  const lineItems = productIds
    .filter((id) => productsMap.has(id))
    .map((id) => {
      const p = productsMap.get(id);
      return { productId: id, name: p.name, price: p.price, lineTotal: parsePrice(p.price) };
    });

  const total = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);

  const channel = await createTicketChannel(interaction, 'order', 'Order');

  if (!gotLock) {
    // Lost the race -- this is the duplicate from a double-click. Clean up
    // the channel we just had to create and point the user at the real one.
    await channel.delete('Duplicate ticket from double-click').catch(() => {});
    return interaction.editReply({
      content: 'Looks like that got clicked twice -- your ticket was already created, check your channel list.',
      components: [],
    });
  }

  await createTicket({
    guildId: interaction.guildId,
    channelId: channel.id,
    category: 'order',
    creatorId: interaction.user.id,
    products: lineItems,
    total,
  });

  await releaseOrderCreateLock(interaction.user.id);

  const summaryLines = lineItems.map((li) => `**${li.name}** — ${formatIDR(li.lineTotal)}`);

  const embed = new EmbedBuilder()
    .setTitle('New Order Ticket')
    .setColor(0x57f287)
    .setDescription(summaryLines.join('\n'))
    .addFields({ name: 'Total', value: formatIDR(total) })
    .setFooter({ text: `Requested by ${interaction.user.tag}` });

  await channel.send({ content: `${interaction.user}`, embeds: [embed] });

  await logCommandActivity(interaction, {
    subcommand: 'send',
    success: true,
    fields: { discordUser: interaction.user },
    note: `Order ticket created: ${channel.id}, total ${total}`,
  });

  return interaction.editReply({
    content: `Ticket created: ${channel}`,
    components: [],
  });
}

// ===========================================================================
// SERVICE FLOW
// ===========================================================================

async function onServiceOpenModalButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(CID.SERVICE_MODAL)
    .setTitle('Service Request');

  const answerInput = new TextInputBuilder()
    .setCustomId('service_answer')
    .setLabel('What type of service do you want?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(answerInput));

  return interaction.showModal(modal);
}

async function onServiceModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const answer = interaction.fields.getTextInputValue('service_answer').trim();

  const channel = await createTicketChannel(interaction, 'service', 'Service');

  await createTicket({
    guildId: interaction.guildId,
    channelId: channel.id,
    category: 'service',
    creatorId: interaction.user.id,
    serviceAnswer: answer,
  });

  const embed = new EmbedBuilder()
    .setTitle('New Service Ticket')
    .setColor(0x5865f2)
    .addFields({ name: 'Requested service', value: answer.slice(0, 1024) })
    .setFooter({ text: `Requested by ${interaction.user.tag}` });

  await channel.send({ content: `${interaction.user}`, embeds: [embed] });

  return interaction.editReply({ content: `Ticket created: ${channel}` });
}

// ===========================================================================
// CUSTOMER SERVICE FLOW
// ===========================================================================

async function onCsCreateButton(interaction) {
  await interaction.deferUpdate();

  const channel = await createTicketChannel(interaction, 'customerservice', 'Customer Service');

  await createTicket({
    guildId: interaction.guildId,
    channelId: channel.id,
    category: 'customerservice',
    creatorId: interaction.user.id,
  });

  await channel.send({
    content: `${interaction.user} Please wait for an admin to answer your ticket.`,
  });

  return interaction.editReply({ content: `Ticket created: ${channel}`, components: [] });
}

// ---------------------------------------------------------------------------
// /ticket done
// ---------------------------------------------------------------------------
async function handleDone(interaction) {
  if (!requireAdmin(interaction)) return requireAdminReply(interaction);

  const channelId = interaction.channelId;

  const ticket = await getTicket(channelId);
  if (!ticket) {
    return interaction.reply({ content: 'This is not a ticket channel.', flags: MessageFlags.Ephemeral });
  }
  if (ticket.status === 'done') {
    return interaction.reply({ content: 'This ticket is already marked done.', flags: MessageFlags.Ephemeral });
  }
  if (ticket.status === 'deleted') {
    return interaction.reply({ content: 'This ticket has already been closed.', flags: MessageFlags.Ephemeral });
  }

  const testiChannelId = await getTestiChannel(interaction.guildId);
  if (!testiChannelId) {
    return interaction.reply({
      content: 'No testimonial channel set. Run `/ticket settesti` first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`${CID.DONE_MODAL}_${channelId}`)
    .setTitle('Testimonial Image');

  const imageInput = new TextInputBuilder()
    .setCustomId('testi_image_url')
    .setLabel('Image URL')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(imageInput));

  await interaction.showModal(modal);

  let modalSubmit;
  try {
    modalSubmit = await interaction.awaitModalSubmit({
      time: 15 * 60 * 1000,
      filter: (i) => i.customId === `${CID.DONE_MODAL}_${channelId}` && i.user.id === interaction.user.id,
    });
  } catch (err) {
    if (err?.code !== 'InteractionCollectorError') console.error('Ticket done modal error:', err);
    return;
  }

  await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });

  const imageUrl = modalSubmit.fields.getTextInputValue('testi_image_url').trim();

  const testiChannel = await interaction.client.channels.fetch(testiChannelId).catch(() => null);
  if (!testiChannel) {
    return modalSubmit.editReply({ content: 'Testimonial channel no longer exists. Run `/ticket settesti` again.' });
  }

  const productList = Array.isArray(ticket.products) && ticket.products.length > 0
    ? ticket.products.map((p) => p.name).join(', ')
    : (ticket.category === 'service' ? 'Service' : 'Customer Service');

  const totalPrice = ticket.total ? formatIDR(ticket.total) : 'N/A';
  const ticketNumber = await nextTicketNumber(interaction.guildId);

  const testiEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setDescription(`TERIMAKASIH SUDAH MEMBELI PRODUK: ${productList} DENGAN TOTAL HARGA: ${totalPrice} | ${imageUrl}`)
    .setImage(imageUrl)
    .setFooter({ text: `Testimonial number ${ticketNumber}` });

  await testiChannel.send({ embeds: [testiEmbed] });

  // Order tickets: /ticket done is the normal purchase-completion path --
  // grant ownership of each product and DM the file link, same delivery
  // pattern /product get already uses. Admins can still grant manually via
  // /product give; this just makes /ticket done do it automatically so the
  // admin doesn't have to do both steps per sale.
  const deliveryFailures = [];
  if (Array.isArray(ticket.products) && ticket.products.length > 0) {
    const creator = await interaction.client.users.fetch(ticket.creatorId).catch(() => null);

    for (const item of ticket.products) {
      await giveProductToUser(item.productId, ticket.creatorId).catch((err) => {
        console.error(`Failed to grant product ${item.productId} to ${ticket.creatorId}:`, err);
        deliveryFailures.push(item.name);
      });

      const product = await getProduct(item.productId).catch(() => null);
      if (!creator || !product?.fileLink) continue;

      try {
        await creator.send(`Here's your file for **${product.name}**: ${product.fileLink}`);
      } catch {
        // DMs closed/blocked -- ownership is still granted, just flag it so
        // the admin knows to deliver the link another way.
        deliveryFailures.push(`${item.name} (DM failed)`);
      }
    }
  }

  await closeTicket(channelId, { ticketNumber });

  await logCommandActivity(interaction, {
    subcommand: 'done',
    success: true,
    fields: { discordUser: interaction.user, ticketChannel: `<#${channelId}>`, total: totalPrice },
  });

  const deliveryNote = deliveryFailures.length > 0
    ? `\nCouldn't fully deliver: ${deliveryFailures.join(', ')}. Check manually.`
    : '';

  return modalSubmit.editReply({ content: `Ticket marked done, testimonial posted.${deliveryNote}` });
}
