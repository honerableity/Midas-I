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
  saveVerifiedUser,
  getVerifiedUser,
  removeVerifiedUser,
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
    )
    .addSubcommand(sub =>
      sub
        .setName('unverify')
        .setDescription('Remove your Roblox verification')
    ),

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand(true);

    // unverify needs showModal() on the raw interaction — Discord rejects showModal()
    // after deferReply() on the same interaction, so this branch skips the defer
    // that every other subcommand uses and acks via showModal() instead.
    if (sub === 'unverify') {
      // Note: unlike other subcommands, this read happens before the ack (showModal
      // counts as the ack, but must fire on the untouched interaction — can't
      // deferReply() first the way /verify start does). Same cold-Firestore risk as
      // the original "Unknown interaction" bug applies here on a cold boot.
      const record = await getVerifiedUser(interaction.user.id);
      if (!record) {
        return interaction.reply({ content: 'You are already not verified!', flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder()
        .setCustomId('unverify_modal')
        .setTitle('Confirm Unverify');

      const usernameInput = new TextInputBuilder()
        .setCustomId('roblox_username')
        .setLabel(`Type your Roblox username to confirm`)
        .setPlaceholder(record.robloxUsername)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
      await interaction.showModal(modal);

      try {
        const modalSubmit = await interaction.awaitModalSubmit({
          time: 2 * 60 * 1000,
          filter: (i) => i.customId === 'unverify_modal' && i.user.id === interaction.user.id,
        });

        await modalSubmit.deferReply({ flags: MessageFlags.Ephemeral });

        const typed = modalSubmit.fields.getTextInputValue('roblox_username').trim();

        // Exact, case-sensitive match against the stored Roblox username.
        if (typed !== record.robloxUsername) {
          return modalSubmit.editReply(`Username didn't match. You typed \`${typed}\`, expected \`${record.robloxUsername}\`. Run \`/verify unverify\` again to retry.`);
        }

        const config = await getGuildConfig(interaction.guildId);

        if (config?.verifiedRoleId) {
          try {
            const guild = await interaction.client.guilds.fetch(interaction.guildId);
            const member = await guild.members.fetch(interaction.user.id);
            await member.roles.remove(config.verifiedRoleId);
          } catch (roleErr) {
            // Don't block the data deletion over a role-removal hiccup (e.g. member
            // left the server, or role was already removed manually) — log and continue.
            console.error('Role removal failed during unverify:', roleErr);
          }
        }

        await removeVerifiedUser(interaction.user.id);

        return modalSubmit.editReply('You have been unverified. Your role and verification data have been removed.');
      } catch (err) {
        // awaitModalSubmit timeout throws here; nothing to reply to since no modal was submitted
        if (err?.code !== 'InteractionCollectorError') {
          console.error('Unverify modal submit error:', err);
        }
        return;
      }
    }

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

          // Save the Discord <-> Roblox link only after role assign is confirmed
          // successful, so no orphan record if role-add fails and user has to retry.
          try {
            await saveVerifiedUser(interaction.user.id, {
              robloxId: profile.robloxId,
              robloxUsername: profile.robloxUsername,
              guildId: interaction.guildId,
            });
          } catch (saveErr) {
            // Role is already assigned at this point — don't fail the whole flow
            // over a Firestore write hiccup, just log it for manual backfill.
            console.error('saveVerifiedUser failed (role already assigned):', saveErr);
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
