const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const { logCommandActivity } = require('../utils/logger.js');
const {
  parseDuration,
  formatDuration,
  isProtectedTarget,
  sendModDM,
  getWarnThresholds,
  addWarnThreshold,
  addWarn,
  getWarnCount,
  resetWarns,
  setHoneypotChannel,
  getHoneypotChannel,
  scheduleExpiringAction,
  clearExpiringActions,
} = require('../utils/moderation.js');

const ACTION_CHOICES = [
  { name: 'ban', value: 'ban' },
  { name: 'kick', value: 'kick' },
  { name: 'mute', value: 'mute' },
  { name: 'role', value: 'role' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderation commands')

    .addSubcommand((sub) =>
      sub
        .setName('ban')
        .setDescription('Ban a user')
        .addUserOption((opt) => opt.setName('user').setDescription('User to ban').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('duration').setDescription('e.g. 10m, 2h, 3d, 1w. Leave empty for permanent').setRequired(false)
        )
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('kick')
        .setDescription('Kick a user')
        .addUserOption((opt) => opt.setName('user').setDescription('User to kick').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('unban')
        .setDescription('Unban a user')
        .addStringOption((opt) => opt.setName('user').setDescription('User ID to unban').setRequired(true))
    )

    .addSubcommand((sub) =>
      sub
        .setName('mute')
        .setDescription('Timeout (mute) a user')
        .addUserOption((opt) => opt.setName('user').setDescription('User to mute').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('duration').setDescription('e.g. 10m, 2h, 3d (max 28d)').setRequired(true)
        )
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('vcmute')
        .setDescription('Voice server-mute a user')
        .addUserOption((opt) => opt.setName('user').setDescription('User to voice-mute').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('duration').setDescription('e.g. 10m, 2h, 3d. Leave empty for indefinite').setRequired(false)
        )
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('unmute')
        .setDescription('Remove an active timeout from a user')
        .addUserOption((opt) => opt.setName('user').setDescription('User to unmute').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('unvcmute')
        .setDescription('Remove voice server-mute from a user')
        .addUserOption((opt) => opt.setName('user').setDescription('User to unmute').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('warn')
        .setDescription('Warn a user (DMs them)')
        .addUserOption((opt) => opt.setName('user').setDescription('User to warn').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('setwarn')
        .setDescription('Set an action that fires at a warn count threshold')
        .addIntegerOption((opt) =>
          opt.setName('warncount').setDescription('Warn count that triggers this').setRequired(true).setMinValue(1)
        )
        .addStringOption((opt) =>
          opt.setName('action').setDescription('Action to take').setRequired(true).addChoices(...ACTION_CHOICES)
        )
        .addStringOption((opt) =>
          opt.setName('duration').setDescription('For mute action: e.g. 10m, 2h, 3d').setRequired(false)
        )
        .addRoleOption((opt) => opt.setName('role').setDescription('For role action: role to give').setRequired(false))
    )

    .addSubcommand((sub) =>
      sub
        .setName('honeypot')
        .setDescription('Set a channel that instant-bans anyone who types in it')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Trap channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    ),

  logSchema: {
    subcommands: {
      ban: { label: 'Mod — Ban', fields: ['discordUser', 'duration', 'reason'] },
      kick: { label: 'Mod — Kick', fields: ['discordUser', 'reason'] },
      unban: { label: 'Mod — Unban', fields: ['discordUser'] },
      mute: { label: 'Mod — Mute', fields: ['discordUser', 'duration', 'reason'] },
      vcmute: { label: 'Mod — VC Mute', fields: ['discordUser', 'duration', 'reason'] },
      unmute: { label: 'Mod — Unmute', fields: ['discordUser', 'reason'] },
      unvcmute: { label: 'Mod — VC Unmute', fields: ['discordUser', 'reason'] },
      warn: { label: 'Mod — Warn', fields: ['discordUser', 'reason', 'warnCount'] },
      setwarn: { label: 'Mod — Set Warn Rule', fields: ['warnCount', 'action', 'duration', 'role'] },
      honeypot: { label: 'Mod — Honeypot Set', fields: ['channel'] },
      honeypotTrigger: { label: 'Mod — Honeypot Triggered', fields: ['discordUser', 'channel'] },
    },
  },

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: 'You need Moderate Members permission to do that.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand(true);

    // Defer immediately -- Firestore reads/writes and Discord member fetches
    // below can blow the 3s ack window. Same guard used across every other
    // command in this codebase.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      switch (sub) {
        case 'ban':
          return await handleBan(interaction);
        case 'kick':
          return await handleKick(interaction);
        case 'unban':
          return await handleUnban(interaction);
        case 'mute':
          return await handleMute(interaction);
        case 'vcmute':
          return await handleVcMute(interaction);
        case 'unmute':
          return await handleUnmute(interaction);
        case 'unvcmute':
          return await handleUnvcMute(interaction);
        case 'warn':
          return await handleWarn(interaction);
        case 'setwarn':
          return await handleSetWarn(interaction);
        case 'honeypot':
          return await handleHoneypot(interaction);
        default:
          return interaction.editReply({ content: 'Unknown subcommand.' });
      }
    } catch (err) {
      console.error(`[mod] ${sub} failed:`, err);
      return interaction.editReply({ content: 'Bot error occurred while running that command.' });
    }
  },

  // Exported for index.js to wire into guildMemberAdd / message listeners if needed later.
  handleHoneypotMessage,
};

// ---------- subcommand handlers ----------

async function handleBan(interaction) {
  const user = interaction.options.getUser('user', true);
  const durationInput = interaction.options.getString('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const durationMs = parseDuration(durationInput);
  if (durationMs === undefined) {
    return interaction.editReply({ content: `Invalid duration "${durationInput}". Use formats like 10m, 2h, 3d, 1w, or leave empty for permanent.` });
  }

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  const guard = isProtectedTarget(interaction.guild, member, user);
  if (guard.blocked) {
    return interaction.editReply({ content: `Can't ban ${user.tag} — protected (${guard.reason}).` });
  }

  if (member && !member.bannable) {
    return interaction.editReply({ content: `I can't ban ${user.tag} — check role hierarchy / my permissions.` });
  }

  // DM before the ban -- once banned, shared guilds may drop and DMs can fail.
  await sendModDM(user, {
    guildName: interaction.guild.name,
    action: 'Banned',
    reason,
    duration: durationMs === null ? 'permanent' : formatDuration(durationMs),
  });

  await interaction.guild.bans.create(user.id, { reason: `${reason} (by ${interaction.user.tag})` });

  await clearExpiringActions(interaction.guildId, user.id, 'ban');
  if (durationMs !== null) {
    await scheduleExpiringAction(interaction.guildId, user.id, 'ban', Date.now() + durationMs, interaction.user.id);
  }

  await interaction.editReply({
    content: `Banned ${user.tag} — ${durationMs === null ? 'permanent' : formatDuration(durationMs)}. Reason: ${reason}`,
  });

  await logCommandActivity(interaction, {
    subcommand: 'ban',
    success: true,
    fields: { discordUser: user, duration: durationMs === null ? 'permanent' : formatDuration(durationMs), reason },
  });
}

async function handleKick(interaction) {
  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ content: `${user.tag} is not in this server.` });
  }

  const guard = isProtectedTarget(interaction.guild, member, user);
  if (guard.blocked) {
    return interaction.editReply({ content: `Can't kick ${user.tag} — protected (${guard.reason}).` });
  }

  if (!member.kickable) {
    return interaction.editReply({ content: `I can't kick ${user.tag} — check role hierarchy / my permissions.` });
  }

  // DM before the kick -- once kicked, DMs can fail if no shared guilds remain.
  await sendModDM(user, { guildName: interaction.guild.name, action: 'Kicked', reason });

  await member.kick(`${reason} (by ${interaction.user.tag})`);

  await interaction.editReply({ content: `Kicked ${user.tag}. Reason: ${reason}` });

  await logCommandActivity(interaction, {
    subcommand: 'kick',
    success: true,
    fields: { discordUser: user, reason },
  });
}

async function handleUnban(interaction) {
  const userId = interaction.options.getString('user', true).trim();

  const banEntry = await interaction.guild.bans.fetch(userId).catch(() => null);
  if (!banEntry) {
    return interaction.editReply({ content: `That user ID is not banned.` });
  }

  await interaction.guild.bans.remove(userId, `Unbanned by ${interaction.user.tag}`);
  await clearExpiringActions(interaction.guildId, userId, 'ban');

  // Best effort -- user isn't in the guild so this only lands if they share
  // another mutual server/DM channel with the bot.
  await sendModDM(banEntry.user, { guildName: interaction.guild.name, action: 'Unbanned', reversal: true });

  await interaction.editReply({ content: `Unbanned ${banEntry.user.tag}.` });

  await logCommandActivity(interaction, {
    subcommand: 'unban',
    success: true,
    fields: { discordUser: banEntry.user },
  });
}

async function handleMute(interaction) {
  const user = interaction.options.getUser('user', true);
  const durationInput = interaction.options.getString('duration', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const durationMs = parseDuration(durationInput);
  if (!durationMs) {
    return interaction.editReply({ content: `Invalid duration "${durationInput}". Use formats like 10m, 2h, 3d (max 28d). Mute cannot be permanent.` });
  }

  const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
  if (durationMs > MAX_TIMEOUT_MS) {
    return interaction.editReply({ content: `Discord timeouts cap at 28 days. Use a shorter duration.` });
  }

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ content: `${user.tag} is not in this server.` });
  }

  const guard = isProtectedTarget(interaction.guild, member, user);
  if (guard.blocked) {
    return interaction.editReply({ content: `Can't mute ${user.tag} — protected (${guard.reason}).` });
  }

  if (!member.moderatable) {
    return interaction.editReply({ content: `I can't timeout ${user.tag} — check role hierarchy / my permissions.` });
  }

  await member.timeout(durationMs, `${reason} (by ${interaction.user.tag})`);

  await sendModDM(user, { guildName: interaction.guild.name, action: 'Muted', reason, duration: formatDuration(durationMs) });

  await interaction.editReply({ content: `Muted ${user.tag} for ${formatDuration(durationMs)}. Reason: ${reason}` });

  await logCommandActivity(interaction, {
    subcommand: 'mute',
    success: true,
    fields: { discordUser: user, duration: formatDuration(durationMs), reason },
  });
}

async function handleVcMute(interaction) {
  const user = interaction.options.getUser('user', true);
  const durationInput = interaction.options.getString('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const durationMs = parseDuration(durationInput);
  if (durationMs === undefined) {
    return interaction.editReply({ content: `Invalid duration "${durationInput}". Use formats like 10m, 2h, 3d, or leave empty for indefinite.` });
  }

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ content: `${user.tag} is not in this server.` });
  }
  if (!member.voice?.channelId) {
    return interaction.editReply({ content: `${user.tag} is not currently in a voice channel.` });
  }

  const guard = isProtectedTarget(interaction.guild, member, user);
  if (guard.blocked) {
    return interaction.editReply({ content: `Can't voice-mute ${user.tag} — protected (${guard.reason}).` });
  }

  if (!member.moderatable) {
    return interaction.editReply({ content: `I can't voice-mute ${user.tag} — check role hierarchy / my permissions.` });
  }

  await member.voice.setMute(true, `${reason} (by ${interaction.user.tag})`);

  await clearExpiringActions(interaction.guildId, user.id, 'vcmute');
  if (durationMs !== null) {
    await scheduleExpiringAction(interaction.guildId, user.id, 'vcmute', Date.now() + durationMs, interaction.user.id);
  }

  await sendModDM(user, {
    guildName: interaction.guild.name,
    action: 'Voice-muted',
    reason,
    duration: durationMs === null ? 'indefinite' : formatDuration(durationMs),
  });

  await interaction.editReply({
    content: `Voice-muted ${user.tag} — ${durationMs === null ? 'indefinite' : formatDuration(durationMs)}. Reason: ${reason}`,
  });

  await logCommandActivity(interaction, {
    subcommand: 'vcmute',
    success: true,
    fields: { discordUser: user, duration: durationMs === null ? 'indefinite' : formatDuration(durationMs), reason },
  });
}

async function handleUnmute(interaction) {
  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ content: `${user.tag} is not in this server.` });
  }
  if (!member.communicationDisabledUntil || member.communicationDisabledUntil < new Date()) {
    return interaction.editReply({ content: `${user.tag} is not currently muted.` });
  }
  if (!member.moderatable) {
    return interaction.editReply({ content: `I can't unmute ${user.tag} — check role hierarchy / my permissions.` });
  }

  await member.timeout(null, `${reason} (by ${interaction.user.tag})`);

  await sendModDM(user, { guildName: interaction.guild.name, action: 'Unmuted', reason, reversal: true });

  await interaction.editReply({ content: `Unmuted ${user.tag}. Reason: ${reason}` });

  await logCommandActivity(interaction, {
    subcommand: 'unmute',
    success: true,
    fields: { discordUser: user, reason },
  });
}

async function handleUnvcMute(interaction) {
  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ content: `${user.tag} is not in this server.` });
  }
  if (!member.voice?.serverMute) {
    return interaction.editReply({ content: `${user.tag} is not currently voice-muted.` });
  }
  if (!member.moderatable) {
    return interaction.editReply({ content: `I can't unmute ${user.tag} — check role hierarchy / my permissions.` });
  }

  await member.voice.setMute(false, `${reason} (by ${interaction.user.tag})`);
  await clearExpiringActions(interaction.guildId, user.id, 'vcmute');

  await sendModDM(user, { guildName: interaction.guild.name, action: 'Voice-unmuted', reason, reversal: true });

  await interaction.editReply({ content: `Voice-unmuted ${user.tag}. Reason: ${reason}` });

  await logCommandActivity(interaction, {
    subcommand: 'unvcmute',
    success: true,
    fields: { discordUser: user, reason },
  });
}

async function handleWarn(interaction) {
  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || 'No reason provided';

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const guard = isProtectedTarget(interaction.guild, member, user);
  if (guard.blocked) {
    return interaction.editReply({ content: `Can't warn ${user.tag} — protected (${guard.reason}).` });
  }

  const data = await addWarn(interaction.guildId, user.id, interaction.user.id, reason);
  const count = data.count;

  // DM the user -- best effort, don't fail the command if DMs are closed.
  const dmEmbed = new EmbedBuilder()
    .setTitle('You received a warning')
    .setDescription(`Server: **${interaction.guild.name}**\nReason: ${reason}\nTotal warns: ${count}`)
    .setColor(0xffaa00);
  await user.send({ embeds: [dmEmbed] }).catch(() => {});

  // Check thresholds and apply the configured action, if any.
  const thresholds = await getWarnThresholds(interaction.guildId);
  const matched = thresholds.find((t) => t.count === count);
  let actionNote = '';

  if (matched) {
    actionNote = await applyThresholdAction(interaction, user, matched).catch((err) => {
      console.error('[mod] threshold action failed:', err);
      return 'Threshold action failed — check bot permissions.';
    });
  }

  await interaction.editReply({
    content: `Warned ${user.tag}. Total warns: ${count}.${actionNote ? `\n${actionNote}` : ''}`,
  });

  await logCommandActivity(interaction, {
    subcommand: 'warn',
    success: true,
    fields: { discordUser: user, reason, warnCount: count },
  });
}

async function applyThresholdAction(interaction, user, threshold) {
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  // Threshold actions fire automatically off warn counts -- still must not
  // touch protected targets (owner / bots / Manage Server holders).
  const guard = isProtectedTarget(interaction.guild, member, user);
  if (guard.blocked) {
    return `Reached ${threshold.count} warns but target is protected (${guard.reason}) — auto-action skipped.`;
  }

  if (threshold.action === 'ban') {
    if (member && !member.bannable) return `Reached ${threshold.count} warns but I can't ban (permissions).`;
    await sendModDM(user, {
      guildName: interaction.guild.name,
      action: 'Banned',
      reason: `Reached ${threshold.count} warns`,
      duration: 'permanent',
    });
    await interaction.guild.bans.create(user.id, { reason: `Auto-ban at ${threshold.count} warns` });
    return `Auto-banned for reaching ${threshold.count} warns.`;
  }

  if (threshold.action === 'kick') {
    if (!member) return `Reached ${threshold.count} warns but user already left.`;
    if (!member.kickable) return `Reached ${threshold.count} warns but I can't kick (permissions).`;
    await sendModDM(user, { guildName: interaction.guild.name, action: 'Kicked', reason: `Reached ${threshold.count} warns` });
    await member.kick(`Auto-kick at ${threshold.count} warns`);
    return `Auto-kicked for reaching ${threshold.count} warns.`;
  }

  if (threshold.action === 'mute') {
    if (!member) return `Reached ${threshold.count} warns but user is not in server.`;
    if (!member.moderatable) return `Reached ${threshold.count} warns but I can't mute (permissions).`;
    const durationMs = parseDuration(threshold.duration) || 10 * 60 * 1000; // fallback 10m
    await member.timeout(durationMs, `Auto-mute at ${threshold.count} warns`);
    await sendModDM(user, {
      guildName: interaction.guild.name,
      action: 'Muted',
      reason: `Reached ${threshold.count} warns`,
      duration: formatDuration(durationMs),
    });
    return `Auto-muted for ${formatDuration(durationMs)} for reaching ${threshold.count} warns.`;
  }

  if (threshold.action === 'role') {
    if (!member) return `Reached ${threshold.count} warns but user is not in server.`;
    if (!threshold.roleId) return `Reached ${threshold.count} warns but no role configured.`;
    await member.roles.add(threshold.roleId, `Auto-role at ${threshold.count} warns`);
    return `Auto-assigned role for reaching ${threshold.count} warns.`;
  }

  return '';
}

async function handleSetWarn(interaction) {
  const warncount = interaction.options.getInteger('warncount', true);
  const action = interaction.options.getString('action', true);
  const durationInput = interaction.options.getString('duration');
  const role = interaction.options.getRole('role');

  if (action === 'mute') {
    const durationMs = parseDuration(durationInput);
    if (!durationMs) {
      return interaction.editReply({ content: `Action "mute" needs a valid duration, e.g. 10m, 2h, 3d.` });
    }
  }

  if (action === 'role' && !role) {
    return interaction.editReply({ content: `Action "role" needs a role option.` });
  }

  const threshold = {
    count: warncount,
    action,
    duration: action === 'mute' ? durationInput : null,
    roleId: action === 'role' ? role.id : null,
  };

  await addWarnThreshold(interaction.guildId, threshold);

  const desc = action === 'mute'
    ? `mute for ${durationInput}`
    : action === 'role'
      ? `give role ${role.name}`
      : action;

  await interaction.editReply({ content: `Set: at ${warncount} warns -> ${desc}.` });

  await logCommandActivity(interaction, {
    subcommand: 'setwarn',
    success: true,
    fields: { warnCount: warncount, action, duration: durationInput, role: role?.name },
  });
}

async function handleHoneypot(interaction) {
  const channel = interaction.options.getChannel('channel', true);

  await setHoneypotChannel(interaction.guildId, channel.id);

  await interaction.editReply({ content: `Honeypot set to ${channel}. Anyone who sends a message there gets banned (7 days) and their messages purged server-wide.` });

  await logCommandActivity(interaction, {
    subcommand: 'honeypot',
    success: true,
    fields: { channel: channel.name },
  });
}

// ---------- honeypot trigger (called from index.js messageCreate listener) ----------

async function handleHoneypotMessage(message) {
  if (!message.guild || message.author.bot) return;

  const honeypotId = await getHoneypotChannel(message.guildId).catch(() => null);
  if (!honeypotId || message.channelId !== honeypotId) return;

  const guild = message.guild;
  const userId = message.author.id;

  // Protected-target guard runs FIRST, before any deletion/purge/ban -- an
  // owner, bot, or Manage Server holder tripping the honeypot must be a total
  // no-op (message stays, nothing purged, no ban).
  const member = await guild.members.fetch(userId).catch(() => null);
  const guard = isProtectedTarget(guild, member, message.author);
  if (guard.blocked) {
    console.error(`[mod] honeypot triggered by ${message.author.tag} but target is protected (${guard.reason}) — ignoring entirely.`);
    return;
  }

  // Delete the triggering message first, best effort.
  await message.delete().catch(() => {});

  // Purge all their messages server-wide: scan text channels for recent messages
  // from this user and bulk-delete. bulkDelete only works on messages <14 days old
  // and is capped at 100 per call -- best-effort sweep, not a guarantee of total erasure.
  const textChannels = guild.channels.cache.filter(
    (c) => c.isTextBased?.() && c.viewable && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages)
  );

  for (const [, channel] of textChannels) {
    try {
      const recent = await channel.messages.fetch({ limit: 100 });
      const theirs = recent.filter((m) => m.author.id === userId);
      if (theirs.size === 1) {
        await theirs.first().delete().catch(() => {});
      } else if (theirs.size > 1) {
        await channel.bulkDelete(theirs, true).catch(() => {});
      }
    } catch (err) {
      console.error(`[mod] honeypot purge failed in #${channel.name}:`, err.message || err);
    }
  }

  if (member && !member.bannable) {
    console.error(`[mod] honeypot triggered by ${message.author.tag} but member is not bannable.`);
    return;
  }

  await sendModDM(message.author, {
    guildName: guild.name,
    action: 'Banned',
    reason: 'Honeypot channel triggered',
    duration: formatDuration(7 * 24 * 60 * 60 * 1000),
  });

  await guild.bans.create(userId, { reason: 'Honeypot channel triggered', deleteMessageSeconds: 7 * 24 * 60 * 60 });

  const { scheduleExpiringAction: schedule } = require('../utils/moderation.js');
  await schedule(guild.id, userId, 'ban', Date.now() + 7 * 24 * 60 * 60 * 1000, guild.client.user.id);

  // Log to the mod command's honeypotTrigger schema entry, if a log channel exists.
  const fakeInteraction = {
    inGuild: () => true,
    guildId: guild.id,
    client: guild.client,
    commandName: 'mod',
  };
  await logCommandActivity(fakeInteraction, {
    subcommand: 'honeypotTrigger',
    success: true,
    fields: { discordUser: message.author, channel: message.channel.name },
  }).catch(() => {});
}
