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
  fetchRobloxProfileDetails,
  descriptionContainsCode,
  saveVerifiedUser,
  getVerifiedUser,
  removeVerifiedUser,
  EXPIRY_MS,
} = require('../utils/verification.js');

// Builds one page of the Groups list onto the given embed. items is a flat
// array of pre-formatted "Name — Role" strings. page is 0-indexed.
function paginateListField(embed, label, items, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const start = clampedPage * pageSize;
  const slice = items.slice(start, start + pageSize);

  const value = slice.length ? slice.join('\n') : 'None';

  embed.addFields({
    name: `${label} (${items.length}) — Page ${clampedPage + 1}/${totalPages}`,
    value,
  });

  return embed;
}

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
    )
    .addSubcommand(sub =>
      sub
        .setName('profile')
        .setDescription('Look up a member\'s linked Roblox profile')
        .addUserOption(opt =>
          opt.setName('user').setDescription('Discord user to look up').setRequired(true)
        )
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
      // showModal() must be the very first thing that happens on this interaction —
      // no Firestore read before it. A cold Firestore connection's first-query
      // handshake can blow past Discord's 3s ack window, same root cause as the
      // original "Unknown interaction" bug. So the record lookup (and the "already
      // not verified" check) moves to *after* showModal(), inside the modal submit
      // handler, where deferReply() gives a fresh 15-minute window instead.
      const modal = new ModalBuilder()
        .setCustomId('unverify_modal')
        .setTitle('Confirm Unverify');

      const usernameInput = new TextInputBuilder()
        .setCustomId('roblox_username')
        .setLabel('Type your Roblox username to confirm')
        .setPlaceholder('Your exact Roblox username')
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

        const record = await getVerifiedUser(interaction.user.id);
        if (!record) {
          return modalSubmit.editReply('You are already not verified!');
        }

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

    // profile is public (not ephemeral) on purpose — mods need to see it to catch misuse —
    // so it gets its own non-ephemeral defer instead of the shared ephemeral one below.
    if (sub === 'profile') {
      await interaction.deferReply();

      const target = interaction.options.getUser('user', true);
      const record = await getVerifiedUser(target.id);

      if (!record) {
        return interaction.editReply({ content: 'The user is not verified!' });
      }

      let details;
      try {
        details = await fetchRobloxProfileDetails(record.robloxId);
      } catch (err) {
        console.error('fetchRobloxProfileDetails failed:', err);
        return interaction.editReply({ content: 'Bot error while contacting Roblox. Try again later.' });
      }

      // Pagination state lives in this closure per response — one profile card,
      // one collector, reset whenever the tab changes (page always starts at 0
      // on a fresh tab so switching Groups -> Account doesn't carry over an
      // out-of-range page index).
      const state = { tab: 'overview', page: 0 };

      const PAGE_SIZE = 10;

      function buildEmbed() {
        const embed = new EmbedBuilder()
          .setTitle(`Roblox Profile — ${details.username}`)
          .setColor(0x00b0f4)
          .setFooter({ text: `Discord: ${target.username}` });

        if (state.tab === 'overview') {
          const createdMs = Date.parse(details.created);
          const accountAgeDays = Number.isNaN(createdMs)
            ? null
            : Math.floor((Date.now() - createdMs) / (1000 * 60 * 60 * 24));

          embed.addFields(
            { name: 'Discord User', value: `${target}`, inline: true },
            { name: 'Roblox Username', value: details.username, inline: true },
            { name: 'Display Name', value: details.displayName || details.username, inline: true },
            {
              name: 'Account Age',
              value: accountAgeDays === null ? 'Unknown' : `${accountAgeDays} days`,
              inline: true,
            },
            { name: 'Verified Badge', value: details.hasVerifiedBadge ? 'Yes' : 'No', inline: true },
            { name: 'Groups', value: `${details.groups.length}`, inline: true }
          );
          return embed;
        }

        if (state.tab === 'groups') {
          return paginateListField(embed, 'Groups', details.groups.map(g => `${g.name} — ${g.role}`), state.page, PAGE_SIZE);
        }

        // account tab
        embed.addFields(
          { name: 'Roblox ID', value: `${record.robloxId}`, inline: true },
          { name: 'Verified At', value: `<t:${Math.floor(record.verifiedAt / 1000)}:F>`, inline: true },
          { name: 'Verified Badge', value: details.hasVerifiedBadge ? 'Yes' : 'No', inline: true }
        );
        return embed;
      }

      function buildComponents(disabled = false) {
        const tabRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('profile_tab_overview').setLabel('Overview').setStyle(state.tab === 'overview' ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled),
          new ButtonBuilder().setCustomId('profile_tab_groups').setLabel('Groups').setStyle(state.tab === 'groups' ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled),
          new ButtonBuilder().setCustomId('profile_tab_account').setLabel('Account').setStyle(state.tab === 'account' ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled)
        );

        const rows = [tabRow];

        // Prev/Next only make sense on the Groups tab, and only get added
        // when there's more than one page to move between.
        if (state.tab === 'groups') {
          const totalPages = Math.max(1, Math.ceil(details.groups.length / PAGE_SIZE));
          if (totalPages > 1) {
            rows.push(new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('profile_page_prev').setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(disabled || state.page === 0),
              new ButtonBuilder().setCustomId('profile_page_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(disabled || state.page >= totalPages - 1)
            ));
          }
        }

        return rows;
      }

      const message = await interaction.editReply({ embeds: [buildEmbed()], components: buildComponents() });

      const collector = message.createMessageComponentCollector({ time: 5 * 60 * 1000 });

      collector.on('collect', async (btnInteraction) => {
        if (btnInteraction.user.id !== interaction.user.id) {
          return btnInteraction.reply({ content: 'Only the person who ran this command can use these buttons.', flags: MessageFlags.Ephemeral });
        }

        if (btnInteraction.customId.startsWith('profile_tab_')) {
          state.tab = btnInteraction.customId.replace('profile_tab_', '');
          state.page = 0; // reset page on tab switch, see note above
        } else if (btnInteraction.customId === 'profile_page_prev') {
          state.page = Math.max(0, state.page - 1);
        } else if (btnInteraction.customId === 'profile_page_next') {
          state.page += 1;
        }

        await btnInteraction.update({ embeds: [buildEmbed()], components: buildComponents() });
      });

      collector.on('end', async () => {
        try {
          await interaction.editReply({ components: buildComponents(true) });
        } catch {
          // message may have been deleted by then; nothing more to do
        }
      });

      return;
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
