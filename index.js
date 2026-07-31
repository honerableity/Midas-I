const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Auto-redeploy slash commands if anything in commands/ changed since last boot.
// Hash is stored on disk (not Firestore) since it only needs to survive this
// container's lifetime, not across wipes -- a wipe means node_modules is gone
// too, so a redeploy on next boot is harmless and correct anyway.
function getCommandsHash() {
  const combined = commandFiles
    .sort()
    .map((f) => fs.readFileSync(path.join(commandsDir, f), 'utf8'))
    .join('\n');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

function maybeDeployCommands() {
  const hashFile = path.join(__dirname, '.commands-hash');
  const currentHash = getCommandsHash();
  const previousHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : null;

  if (currentHash === previousHash) {
    console.log('Commands unchanged, skipping deploy.');
    return;
  }

  console.log('Command files changed (or first boot), deploying slash commands...');
  const { execFileSync } = require('child_process');
  try {
    const output = execFileSync('node', [path.join(__dirname, 'deploy-commands.js')], { encoding: 'utf8' });
    console.log(output.trim());
    fs.writeFileSync(hashFile, currentHash);
  } catch (err) {
    console.error('Auto-deploy failed:', err.stdout || err.message || err);
    console.error('Bot will still start, but slash commands may be out of date. Run `node deploy-commands.js` manually.');
  }
}

maybeDeployCommands();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
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
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

client.login(process.env.DISCORD_TOKEN);