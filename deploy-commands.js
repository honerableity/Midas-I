const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
require('dotenv').config();

const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing env var(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  process.exit(1);
}

const commandsDir = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

const commands = [];
for (const file of commandFiles) {
  const cmd = require(path.join(commandsDir, file));
  if (!cmd?.data) {
    console.warn(`Skipped ${file}: no "data" export found.`);
    continue;
  }
  commands.push(cmd.data.toJSON());
}

if (commands.length === 0) {
  console.error('No valid commands found in ./commands. Nothing to deploy.');
  process.exit(1);
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log(`Deploying ${commands.length} command(s): ${commands.map((c) => c.name).join(', ')}`);
  try {
    const result = await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log(`Slash commands registered successfully. Discord confirmed ${result.length} command(s) live.`);
  } catch (err) {
    console.error('Slash command deploy FAILED:', err.message || err);
    process.exitCode = 1;
  }
})();