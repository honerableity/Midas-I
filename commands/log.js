const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const { getLogConfig, saveLogCategory, resolveLogCategory, syncLogChannels } = require('../utils/logger.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('log')
    .setDescription('Configure bot activity logging')
    .addSubcommand(sub =>
      sub
        .setName('setcategory')
        .setDescription('Set (or create) the category logs go into, and generate log channels')
        .addChannelOption(opt =>
          opt
            .setName('category')
            .setDescription('Existing category to use. Leave empty to create an owner-only category.')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('update')
        .setDescription('Scan commands/ and create log channels for any commands missing one')
    ),

  // This command's own activity isn't run through logCommandActivity — logging
  // the logger's own config changes adds little value and setcategory runs
  // before any log channel exists on first-ever setup, so there'd be nothing
  // to log to yet anyway.
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission to do that.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand(true);

    // Defer immediately, before any Firestore reads or Discord channel-creation
    // calls — same "Unknown interaction" guard used in verify.js: a cold
    // Firestore connection's first-query handshake can exceed Discord's 3s
    // ack window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'setcategory') {
      const categoryOption = interaction.options.getChannel('category');

      let category;
      try {
        category = await resolveLogCategory(interaction.guild, categoryOption);
      } catch (err) {
        console.error('resolveLogCategory failed:', err);
        return interaction.editReply({ content: 'Bot error while creating the log category. Check my Manage Channels permission.' });
      }

      await saveLogCategory(interaction.guildId, category.id);

      let summary;
      try {
        summary = await syncLogChannels(interaction.guild, interaction.guildId, category.id);
      } catch (err) {
        console.error('syncLogChannels failed:', err);
        return interaction.editReply({
          content: `Log category set to ${category}, but channel creation failed partway through. Run \`/log update\` to retry.`,
        });
      }

      return interaction.editReply({ content: buildSummaryMessage(category, summary) });
    }

    // sub === 'update'
    const config = await getLogConfig(interaction.guildId);
    if (!config?.logCategoryId) {
      return interaction.editReply({ content: 'No log category set yet. Run `/log setcategory` first.' });
    }

    const category = await interaction.guild.channels.fetch(config.logCategoryId).catch(() => null);
    if (!category) {
      return interaction.editReply({
        content: 'The configured log category no longer exists (deleted?). Run `/log setcategory` again to set a new one.',
      });
    }

    let summary;
    try {
      summary = await syncLogChannels(interaction.guild, interaction.guildId, category.id);
    } catch (err) {
      console.error('syncLogChannels failed:', err);
      return interaction.editReply({ content: 'Bot error while creating log channels. Check my Manage Channels permission.' });
    }

    return interaction.editReply({ content: buildSummaryMessage(category, summary) });
  },
};

function buildSummaryMessage(category, { created, alreadyExists, skippedNoSchema }) {
  const lines = [`Log category: ${category}`];

  lines.push(created.length ? `✅ Created: ${created.join(', ')}` : '✅ Created: none');
  lines.push(alreadyExists.length ? `↩️ Already existed: ${alreadyExists.join(', ')}` : '↩️ Already existed: none');

  if (skippedNoSchema.length) {
    lines.push(`⚠️ Skipped (no logSchema defined yet): ${skippedNoSchema.join(', ')}`);
  }

  return lines.join('\n');
}
