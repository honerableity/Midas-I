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
const { logCommandActivity } = require('../utils/logger.js');
const { listProductTypes, listProductsByType, getProduct } = require('../utils/products.js');
const {
  setTestiChannel,
  getTestiChannel,
  nextTicketNumber,
  createTicket,
  getTicket,
  closeTicket,
} = require('../utils/tickets.js');

const MAX_SELECT_OPTIONS = 25;

// customId prefixes -- routed from index.js's global component handler since
// the panel embed and its buttons/selects outlive the /ticket send command's
// own interaction lifetime (people click days later, after a bot restart).
const CID = {
  PANEL_CATEGORY_SELECT: 'ticket_panel_category',
  ORDER_PRODUCT_SELECT: 'ticket_order_products',
  ORDER_QTY_BTN: 'ticket_order_qty', // ticket_order_qty_{inc|dec}_{productId}
  ORDER_CREATE_BTN: 'ticket_order_create',
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
    )
    .addSubcommand(sub =>
      sub
        .setName('done')
        .setDescription('Mark a ticket as done and post testimonial')
        .addStringOption(opt =>
          opt.setName('ticketchannelid').setDescription('Ticket channel ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('settesti')
        .setDescription('Set the testimonial channel')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Testimonial channel').setRequired(true).addChannelTypes(ChannelType.GuildText)
        )
    ),

  logSchema: {
    subcommands: {
      send: { label: 'Ticket — Panel Sent', fields: ['discordUser'] },
      done: { label: 'Ticket — Closed', fields: ['discordUser', 'ticketChannel', 'total'] },
      settesti: { label: 'Ticket — Testimonial Channel Set', fields: ['discordUser', 'channel'] },
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
  },

  // Called from index.js's global interactionCreate router for any
  // button/select/modal customId starting with "ticket_". Keeping this
  // dispatch table here (not in index.js) so all ticket logic stays in one
  // file, same as how product.js/verify.js self-contain their flows.
  async handleComponent(interaction) {
    const id = interaction.customId;

    if (id === CID.PANEL_CATEGORY_SELECT) return onPanelCategorySelect(interaction);
    if (id === CID.ORDER_PRODUCT_SELECT) return onOrderProductSelect(interaction);
    if (id.startsWith(CID.ORDER_QTY_BTN)) return onOrderQtyButton(interaction);
    if (id === CID.ORDER_CREATE_BTN) return onOrderCreateButton(interaction);
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

  await modalSubmit.reply({ embeds: [embed], components: [row] });

  await logCommandActivity(interaction, {
    subcommand: 'send',
    success: true,
    fields: { discordUser: interaction.user },
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

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
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
// option limit). Per-product qty steppers come after selection, not before,
// since Discord select menus can't carry per-option numeric input.
async function onPanelCategorySelect(interaction) {
  const category = interaction.values[0];

  if (category === 'order') {
    const types = await listProductTypes(interaction.guildId);
    if (types.length === 0) {
      return interaction.reply({ content: 'No products are available right now.', flags: MessageFlags.Ephemeral });
    }

    let allProducts = [];
    for (const type of types) {
      const products = await listProductsByType(interaction.guildId, type.id);
      allProducts = allProducts.concat(products);
    }

    if (allProducts.length === 0) {
      return interaction.reply({ content: 'No products are available right now.', flags: MessageFlags.Ephemeral });
    }

    const options = allProducts.slice(0, MAX_SELECT_OPTIONS).map((p) => ({
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

    return interaction.reply({
      content: 'Pick the product(s) you want to buy:',
      components: [new ActionRowBuilder().addComponents(select)],
      flags: MessageFlags.Ephemeral,
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

// Cart state is kept in the ephemeral message's embed/components themselves
// (qty encoded in the button labels) rather than in memory/Firestore, so it
// survives fine across multiple button clicks without needing a cache --
// each click re-reads the current cart from the message it's attached to.
function buildCartFromMessage(message, allProductsMap) {
  // Cart rows are stored as one ActionRow per product: [qty label button
  // (disabled, shows "Name x2"), "-" button, "+" button]. Parse back out.
  const cart = [];
  for (const row of message.components) {
    const buttons = row.components;
    const qtyBtn = buttons.find((b) => b.customId?.startsWith(`${CID.ORDER_QTY_BTN}_label_`));
    if (!qtyBtn) continue;
    const productId = qtyBtn.customId.replace(`${CID.ORDER_QTY_BTN}_label_`, '');
    const match = qtyBtn.label.match(/x(\d+)$/);
    const qty = match ? parseInt(match[1], 10) : 1;
    cart.push({ productId, qty });
  }
  return cart;
}

function buildCartComponents(cart, productsMap) {
  const rows = cart.map((item) => {
    const product = productsMap.get(item.productId);
    const name = product ? product.name : 'Unknown product';
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CID.ORDER_QTY_BTN}_dec_${item.productId}`)
        .setLabel('-')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${CID.ORDER_QTY_BTN}_label_${item.productId}`)
        .setLabel(`${name} x${item.qty}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${CID.ORDER_QTY_BTN}_inc_${item.productId}`)
        .setLabel('+')
        .setStyle(ButtonStyle.Secondary),
    );
  });

  // Discord caps 5 action rows per message; qty rows use up to 4, leaving
  // the last row for the Create ticket button.
  const cartRows = rows.slice(0, 4);

  const createRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CID.ORDER_CREATE_BTN)
      .setLabel('Create ticket')
      .setStyle(ButtonStyle.Success)
  );

  return [...cartRows, createRow];
}

async function loadProductsMap(productIds) {
  const map = new Map();
  for (const id of productIds) {
    const p = await getProduct(id);
    if (p) map.set(id, p);
  }
  return map;
}

// Initial product multi-select submit -> build the qty-stepper cart, all
// items starting at qty 1.
async function onOrderProductSelect(interaction) {
  const productIds = interaction.values;
  const productsMap = await loadProductsMap(productIds);

  const cart = productIds.filter((id) => productsMap.has(id)).map((id) => ({ productId: id, qty: 1 }));

  if (cart.length === 0) {
    return interaction.update({ content: 'Selected product(s) no longer exist. Try again.', components: [] });
  }

  const components = buildCartComponents(cart, productsMap);

  return interaction.update({
    content: 'Adjust quantity with +/- then click **Create ticket**:',
    components,
  });
}

// +/- buttons on the cart. Re-derives cart state from the message's current
// buttons (see buildCartFromMessage) so no external state store is needed.
async function onOrderQtyButton(interaction) {
  const id = interaction.customId;
  const isInc = id.startsWith(`${CID.ORDER_QTY_BTN}_inc_`);
  const isDec = id.startsWith(`${CID.ORDER_QTY_BTN}_dec_`);
  if (!isInc && !isDec) return;

  const productId = id.replace(`${CID.ORDER_QTY_BTN}_${isInc ? 'inc' : 'dec'}_`, '');

  const cart = buildCartFromMessage(interaction.message);
  const item = cart.find((c) => c.productId === productId);
  if (!item) return interaction.deferUpdate();

  if (isInc) item.qty = Math.min(item.qty + 1, 99);
  if (isDec) item.qty = Math.max(item.qty - 1, 1);

  const productsMap = await loadProductsMap(cart.map((c) => c.productId));
  const components = buildCartComponents(cart, productsMap);

  return interaction.update({ components });
}

// "Create ticket" on the order cart -> creates the channel, sums total,
// writes the ticket doc, posts a summary embed inside the new channel.
async function onOrderCreateButton(interaction) {
  await interaction.deferUpdate();

  const cart = buildCartFromMessage(interaction.message);
  if (cart.length === 0) {
    return interaction.editReply({ content: 'Cart is empty.', components: [] });
  }

  const productsMap = await loadProductsMap(cart.map((c) => c.productId));

  const lineItems = cart
    .filter((c) => productsMap.has(c.productId))
    .map((c) => {
      const p = productsMap.get(c.productId);
      const unitPrice = parsePrice(p.price);
      return {
        productId: c.productId,
        name: p.name,
        price: p.price,
        qty: c.qty,
        lineTotal: unitPrice * c.qty,
      };
    });

  const total = lineItems.reduce((sum, li) => sum + li.lineTotal, 0);

  const channel = await createTicketChannel(interaction, 'order', 'Order');

  await createTicket({
    guildId: interaction.guildId,
    channelId: channel.id,
    category: 'order',
    creatorId: interaction.user.id,
    products: lineItems,
    total,
  });

  const summaryLines = lineItems.map((li) => `**${li.name}** x${li.qty} — ${formatIDR(li.price ? parsePrice(li.price) : 0) || li.price} each = ${formatIDR(li.lineTotal)}`);

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

  const channelId = interaction.options.getString('ticketchannelid', true).trim();

  if (interaction.channelId !== channelId) {
    return interaction.reply({
      content: 'You must run this command inside the ticket channel itself.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const ticket = await getTicket(channelId);
  if (!ticket) {
    return interaction.reply({ content: 'No ticket record found for this channel.', flags: MessageFlags.Ephemeral });
  }
  if (ticket.status === 'done') {
    return interaction.reply({ content: 'This ticket is already marked done.', flags: MessageFlags.Ephemeral });
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
    ? ticket.products.map((p) => `${p.name} x${p.qty}`).join(', ')
    : (ticket.category === 'service' ? 'Service' : 'Customer Service');

  const totalPrice = ticket.total ? formatIDR(ticket.total) : 'N/A';
  const ticketNumber = await nextTicketNumber(interaction.guildId);

  const testiEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setDescription(`TERIMAKASIH SUDAH MEMBELI PRODUK: ${productList} DENGAN TOTAL HARGA: ${totalPrice} | ${imageUrl}`)
    .setImage(imageUrl)
    .setFooter({ text: `Testimonial number ${ticketNumber}` });

  await testiChannel.send({ embeds: [testiEmbed] });

  await closeTicket(channelId, { ticketNumber });

  await logCommandActivity(interaction, {
    subcommand: 'done',
    success: true,
    fields: { discordUser: interaction.user, ticketChannel: `<#${channelId}>`, total: totalPrice },
  });

  return modalSubmit.editReply({ content: 'Ticket marked done, testimonial posted.' });
}
