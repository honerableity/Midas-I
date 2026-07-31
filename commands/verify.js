const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const {
  createSession,
  getSession,
  clearSession,
  getGuildConfig,
  setGuildRole,
  fetchRobloxDescription,
  descriptionContainsCode,
  EXPIRY_MS,
} = require('../utils/verification.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Roblox account')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('Start Roblox verification (DMs you a code)')
    )
    .addSubcommand(sub =>
      sub
        .setName('setrole')
        .setDescription('Set the role given after verification')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to assign on verify').setRequired(true)
        )
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand(true);

    // Defer immediately, before any Firestore reads. A cold Firestore connection
    // (first query after bot boot) can take long enough to blow past Discord's
    // 3-second ack window, which made a plain reply() fail with "Unknown interaction".
    // deferReply() acks instantly and buys up to 15 minutes to editReply() the result.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'setrole') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply({ content: 'You need Manage Roles permission to do that.' });
      }
      const role = interaction.options.getRole('role');
      await setGuildRole(interaction.guildId, role.id);
      return interaction.editReply({ content: `Verified role set to ${role}.` });
    }

    // sub === 'start'
    const config = await getGuildConfig(interaction.guildId);
    if (!config || !config.verifiedRoleId) {
      return interaction.editReply({
        content: 'Verify role isn\'t set up yet. Ask an admin to run `/verify setrole` first.',
      });
    }

    const existing = await getSession(interaction.user.id);
    if (existing) {
      return interaction.editReply({
        content: `You already have an active verification code. Check your DMs, or wait <t:${Math.floor(existing.expiresAt / 1000)}:R> for it to expire before starting over.`,
      });
    }

    await interaction.editReply({ content: 'Check your DMs! 📬' });

    const { code, expiresAt } = await createSession(interaction.user.id);

    const embed = new EmbedBuilder()
      .setTitle('Roblox Verification')
      .setDescription(
        `Copy this code and paste it anywhere in your Roblox profile **About/Description**:\n\n` +
        `\`\`\`${code}\`\`\`\n` +
        `This code expires <t:${Math.floor(expiresAt / 1000)}:R>.\n\n` +
        `Once it's on your profile, click **Verify!** below.`
      )
      .setColor(0x00b0f4);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_button').setLabel('Verify!').setStyle(ButtonStyle.Success)
    );

    try {
      const dm = await interaction.user.send({ embeds: [embed], components: [row] });

      const collector = dm.createMessageComponentCollector({ time: EXPIRY_MS });

      collector.on('collect', async (btnInteraction) => {
        if (btnInteraction.customId !== 'verify_button') return;

        const modal = new ModalBuilder()
          .setCustomId('verify_modal')
          .setTitle('Roblox Verification');

        const usernameInput = new TextInputBuilder()
          .setCustomId('roblox_username')
          .setLabel('Your Roblox Username')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));

        await btnInteraction.showModal(modal);

        try {
          const modalSubmit = await btnInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: (i) => i.customId === 'verify_modal' && i.user.id === interaction.user.id,
          });

          const username = modalSubmit.fields.getTextInputValue('roblox_username').trim();
          await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });

          const session = await getSession(interaction.user.id);
          if (!session || Date.now() > session.expiresAt) {
            return modalSubmit.editReply('Your verification code expired. Run `/verify start` again.');
          }

          let profile;
          try {
            profile = await fetchRobloxDescription(username);
          } catch (err) {
            return modalSubmit.editReply('Bot error while contacting Roblox. Try again later.');
          }

          if (profile.notFound) {
            return modalSubmit.editReply('That Roblox username was not found. Check spelling and try again.');
          }

          if (!descriptionContainsCode(profile.description, session.code)) {
            return modalSubmit.editReply(
              `Code not found in your Roblox profile description yet. Make sure \`${session.code}\` is pasted in your About section, then click Verify! again.`
            );
          }

          // success
          const guild = await interaction.client.guilds.fetch(interaction.guildId);
          const member = await guild.members.fetch(interaction.user.id);
          const cfg = await getGuildConfig(interaction.guildId);

          if (!cfg || !cfg.verifiedRoleId) {
            return modalSubmit.editReply('Bot error: verified role is no longer configured.');
          }

          try {
            await member.roles.add(cfg.verifiedRoleId);
          } catch (roleErr) {
            console.error('Role assign failed:', roleErr);
            return modalSubmit.editReply('Bot error: could not assign role. Check my role position/permissions.');
          }

          await clearSession(interaction.user.id);
          collector.stop('verified');

          return modalSubmit.editReply(`Verified! You're linked as **${profile.robloxUsername}**. Role assigned.`);
        } catch (err) {
          // awaitModalSubmit timeout throws here; nothing to reply to since no modal was submitted
          if (err?.code !== 'InteractionCollectorError') {
            console.error('Modal submit error:', err);
          }
        }
      });

      collector.on('end', async (_collected, reason) => {
        if (reason === 'verified') return; // already handled above
        await clearSession(interaction.user.id);
        try {
          await interaction.user.send('Your verification code expired without completing verification. Run `/verify start` again to get a new code.');
        } catch {
          // user may have DMs closed by now; nothing more we can do
        }
      });
    } catch (err) {
      return interaction.followUp({
        content: 'Could not DM you. Please enable DMs from server members and run `/verify start` again.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
