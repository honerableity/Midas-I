const fs = require('fs');
const path = require('path');
const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { db } = require('./firebase.js');

const commandsDir = path.join(__dirname, '..', 'commands');

// Reads every commands/*.js file fresh each time (not cached at module load) so a
// bot restart after adding a new command file always picks it up without extra
// wiring. Files that don't export `data.name` are skipped the same way index.js
// skips them when building client.commands.
function loadCommandDescriptors() {
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
  const descriptors = [];

  for (const file of files) {
    let cmd;
    try {
      cmd = require(path.join(commandsDir, file));
    } catch (err) {
      console.warn(`[logger] Could not load ${file} for log scan: ${err.message}`);
      continue;
    }
    if (!cmd?.data?.name) continue;

    descriptors.push({
      file,
      name: cmd.data.name,
      channelName: `${cmd.data.name}-logs`,
      logSchema: cmd.logSchema || null, // null = command hasn't opted into structured logging yet
    });
  }

  return descriptors;
}

async function getLogConfig(guildId) {
  const snap = await db.collection('guildConfig').doc(guildId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return {
    logCategoryId: data.logCategoryId || null,
    logChannels: data.logChannels || {},
  };
}

async function saveLogCategory(guildId, categoryId) {
  await db.collection('guildConfig').doc(guildId).set({ logCategoryId: categoryId }, { merge: true });
}

async function saveLogChannel(guildId, commandName, channelId) {
  await db.collection('guildConfig').doc(guildId).set(
    { logChannels: { [commandName]: channelId } },
    { merge: true }
  );
}

// Creates the log category if `categoryOption` is null: owner-only visibility
// (@everyone denied ViewChannel, no explicit owner allow needed since server
// owners bypass channel overwrites entirely — but the bot's own permission
// overwrite is added explicitly so it can still post/manage channels inside).
// If `categoryOption` is provided, it's used as-is (existing category, whatever
// permissions it already has are left alone).
async function resolveLogCategory(guild, categoryOption) {
  if (categoryOption) {
    return categoryOption;
  }

  const category = await guild.channels.create({
    name: 'Bot Logs',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: guild.client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ],
  });

  return category;
}

// Scans commands/, creates a `{command}-logs` channel under the log category
// for any command that doesn't already have one on record. Existing channels
// are left untouched (renamed commands or manual channel deletes are not
// auto-repaired here — re-running after fixing the mismatch is enough).
// Returns a summary for the calling command to report back to the admin.
async function syncLogChannels(guild, guildId, categoryId) {
  const descriptors = loadCommandDescriptors();
  const config = await getLogConfig(guildId);
  const existingChannels = config?.logChannels || {};

  const created = [];
  const skippedNoSchema = [];
  const alreadyExists = [];

  for (const desc of descriptors) {
    const existingId = existingChannels[desc.name];
    const stillValid = existingId && guild.channels.cache.has(existingId);

    if (stillValid) {
      alreadyExists.push(desc.channelName);
      continue;
    }

    if (!desc.logSchema) {
      // Command hasn't defined logSchema yet — don't create a blind/generic
      // channel for it, just flag it so the admin (or dev) knows to add one.
      console.warn(`[logger] Skipping channel creation for "${desc.name}" — no logSchema exported.`);
      skippedNoSchema.push(desc.name);
      continue;
    }

    const channel = await guild.channels.create({
      name: desc.channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `Activity log for /${desc.name}`,
    });

    await saveLogChannel(guildId, desc.name, channel.id);
    created.push(desc.channelName);
  }

  return { created, alreadyExists, skippedNoSchema };
}

// Formats a value for embed display based on its runtime shape rather than
// per-field special-casing, so logSchema authors don't need to declare a type
// per field — a Discord User/GuildMember becomes a mention, everything else
// is stringified.
function formatFieldValue(value) {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'object' && 'id' in value) {
    // Covers User, GuildMember, Role, Channel — all of which render correctly
    // via <@id>/<@&id>/<#id> mention syntax that Discord.js objects share
    // through toString(), so just defer to that instead of guessing the type.
    return value.toString();
  }
  return String(value);
}

// Sends one log entry to the command's log channel, if logging is configured
// for this guild and this specific command has a channel on record. Silently
// no-ops (not throws) when logging isn't set up, so commands can call this
// unconditionally without needing to check "is logging enabled" themselves —
// mirrors the crash-safe philosophy used for error-reply failures elsewhere.
async function logCommandActivity(interaction, { subcommand, success, fields = {}, note = null }) {
  try {
    if (!interaction.inGuild()) return;

    const config = await getLogConfig(interaction.guildId);
    const channelId = config?.logChannels?.[interaction.commandName];
    if (!channelId) return; // logging not set up for this command in this guild

    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel) return; // channel was deleted manually; nothing to log to

    const cmd = interaction.client.commands.get(interaction.commandName);
    const schemaEntry = cmd?.logSchema?.subcommands?.[subcommand];
    const label = schemaEntry?.label || subcommand || interaction.commandName;

    const embed = new EmbedBuilder()
      .setTitle(label)
      .setColor(success ? 0x57f287 : 0xed4245)
      .addFields({ name: 'Status', value: success ? '✅ Success' : '❌ Failed', inline: true })
      .addFields({ name: 'Run By', value: `${interaction.user}`, inline: true })
      .setTimestamp();

    for (const [key, value] of Object.entries(fields)) {
      // discordUser is redundant with the "Run By" field added above — every
      // logCommandActivity call from verify.js passes it for documentation/
      // consistency with logSchema, but it shouldn't render twice.
      if (key === 'discordUser') continue;
      embed.addFields({ name: key, value: formatFieldValue(value), inline: true });
    }

    if (note) {
      embed.addFields({ name: 'Note', value: String(note).slice(0, 1024) });
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    // Logging must never break the command it's logging. Log the failure to
    // console and move on — same reasoning as the error-reply try/catch in
    // index.js.
    console.error('[logger] logCommandActivity failed:', err);
  }
}

module.exports = {
  loadCommandDescriptors,
  getLogConfig,
  saveLogCategory,
  saveLogChannel,
  resolveLogCategory,
  syncLogChannels,
  logCommandActivity,
};
