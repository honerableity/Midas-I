const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
require('dotenv').config();

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
for (const file of commandFiles) {
  const cmd = require(path.join(commandsDir, file));
  if (!cmd?.data?.name) {
    console.warn(`Skipped loading ${file}: missing "data.name" export.`);
    continue;
  }
  client.commands.set(cmd.data.name, cmd);
}

// Always redeploy slash commands on boot. Previously skipped when a
// content-hash matched a stored .commands-hash file -- dropped because
// Discloud's file container is paywalled/unreachable, so a stale hash file
// left over from a prior boot can never be manually cleared, causing "unchanged"
// false positives even after real command edits. Deploying every boot costs
// one extra Discord API call; harmless on free tier.
function deployCommands() {
  console.log('Deploying slash commands...');
  const { execFileSync } = require('child_process');
  try {
    const output = execFileSync('node', [path.join(__dirname, 'deploy-commands.js')], { encoding: 'utf8' });
    console.log(output.trim());
  } catch (err) {
    console.error('Auto-deploy failed:', err.stdout || err.message || err);
    console.error('Bot will still start, but slash commands may be out of date. Run `node deploy-commands.js` manually.');
  }
}

deployCommands();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`Error in /${interaction.commandName}:`, err);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: 'Bot error occurred.', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: 'Bot error occurred.', flags: MessageFlags.Ephemeral });
        }
      } catch (replyErr) {
        // Interaction likely expired (>3s) or was already acknowledged elsewhere.
        // Nothing more we can do -- log and move on, don't let this crash the process.
        console.error('Could not send error reply (interaction likely expired):', replyErr.message || replyErr);
      }
    }
    return;
  }

  // Global router for persistent buttons/selects/modals that outlive the
  // command interaction that created them (e.g. the /ticket send panel --
  // still needs to work after a bot restart, unlike the in-command
  // awaitMessageComponent collectors used elsewhere). Routed by customId
  // prefix "ticket_" to commands/ticket.js's handleComponent().
  const isComponent = interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit();
  if (!isComponent) return;
  if (!interaction.customId?.startsWith('ticket_')) return;

  const ticketCommand = client.commands.get('ticket');
  if (!ticketCommand?.handleComponent) return;

  try {
    await ticketCommand.handleComponent(interaction);
  } catch (err) {
    console.error('Error in ticket component handler:', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'Bot error occurred.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'Bot error occurred.', flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      console.error('Could not send error reply (interaction likely expired):', replyErr.message || replyErr);
    }
  }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

client.login(process.env.DISCORD_TOKEN);
