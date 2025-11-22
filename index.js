require("dotenv").config();

const http = require("http");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  Events
} = require("discord.js");
const fs = require("fs");
const path = require("path");

// ---- Basic config ----

// Optional: role IDs allowed to run mod commands in addition to Manage Guild permission.
const MOD_ROLE_IDS = [
  // "123456789012345678"
];

// Path for persistent data
const DATA_PATH = path.join(__dirname, "skirmish-data.json");

// ---- Types / defaults ----

function createEmptyPlayer() {
  return {
    displayName: null,
    registered: false,
    deckLink: null,
    deckSubmitted: false,
    deckReviewed: false
  };
}

// ---- Data helpers ----

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);

    // Backwards compatibility with older format
    const players = parsed.players && typeof parsed.players === "object"
      ? parsed.players
      : {};

    // If old allowedUserIds exist, migrate them into players as registered users
    if (Array.isArray(parsed.allowedUserIds)) {
      for (const id of parsed.allowedUserIds) {
        if (!players[id]) {
          players[id] = createEmptyPlayer();
        }
        players[id].registered = true;
      }
    }

    return {
      submissionsChannelId: parsed.submissionsChannelId ?? null,
      players
    };
  } catch (err) {
    return {
      submissionsChannelId: null,
      players: {}
    };
  }
}

function saveData(data) {
  const safe = {
    submissionsChannelId: data.submissionsChannelId ?? null,
    players: data.players || {}
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(safe, null, 2), "utf8");
}

let state = loadData();

function getOrCreatePlayer(userId) {
  if (!state.players[userId]) {
    state.players[userId] = createEmptyPlayer();
  }
  return state.players[userId];
}

// ---- Discord client ----

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

// ---- Slash command definitions ----

const commands = [
  // Combined player command with subcommands: connect + submit
  new SlashCommandBuilder()
    .setName("radskirmish")
    .setDescription("Connect your RPN display name and submit your decklist.")
    .addSubcommand(sub =>
      sub
        .setName("connect")
        .setDescription("Connect your Discord to your Riftbound Play Network Display Name.")
        .addStringOption(opt =>
          opt
            .setName("display_name")
            .setDescription("Your Riftbound Play Network Display Name")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("submit")
        .setDescription("Submit your Piltover deck link for this Summoner Skirmish.")
        .addStringOption(opt =>
          opt
            .setName("link")
            .setDescription("Piltover Archive deck link")
            .setRequired(true)
        )
    ),

  // Mod command: set submissions channel
  new SlashCommandBuilder()
    .setName("skirmish-set-submissions")
    .setDescription("Set the channel where decklists will be posted.")
    .addChannelOption(opt =>
      opt
        .setName("channel")
        .setDescription("Channel for decklist submissions")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),

  // Mod command: allow a player (mark them registered)
  new SlashCommandBuilder()
    .setName("skirmish-allow")
    .setDescription("Mark a player as registered for this Summoner Skirmish.")
    .addUserOption(opt =>
      opt
        .setName("user")
        .setDescription("Player to mark as registered")
        .setRequired(true)
    ),

  // Mod command: remove a player (unregister and clear their deck info)
  new SlashCommandBuilder()
    .setName("skirmish-remove")
    .setDescription("Unregister a player and clear their deck submission.")
    .addUserOption(opt =>
      opt
        .setName("user")
        .setDescription("Player to remove")
        .setRequired(true)
    ),

  // Mod command: mark deck as reviewed/unreviewed
  new SlashCommandBuilder()
    .setName("skirmish-reviewed")
    .setDescription("Mark whether a player's decklist has been reviewed.")
    .addUserOption(opt =>
      opt
        .setName("user")
        .setDescription("Player")
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt
        .setName("reviewed")
        .setDescription("Has this player's deck been reviewed?")
        .setRequired(true)
    ),

  // Mod command: list players + deck status
  new SlashCommandBuilder()
    .setName("skirmish-list")
    .setDescription("Show all known players and their deck submission / review status.")
].map(cmd => cmd.toJSON());

// ---- Command registration ----

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.GUILD_ID || null;

  try {
    if (!clientId) {
      console.error("DISCORD_CLIENT_ID is not set – cannot register commands.");
      return;
    }

    if (guildId) {
      console.log(`Registering guild commands for guild ${guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log("Guild commands registered.");
    } else {
      console.log("Registering global commands...");
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log("Global commands registered.");
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ---- Permission helpers ----

function isMod(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  if (MOD_ROLE_IDS.length > 0) {
    const memberRoles = interaction.member?.roles?.valueOf();
    if (memberRoles && typeof memberRoles.has === "function") {
      for (const roleId of MOD_ROLE_IDS) {
        if (memberRoles.has(roleId)) {
          return true;
        }
      }
    }
  }

  return false;
}

// ---- Event handlers ----

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "radskirmish":
        await handleRadSkirmish(interaction);
        break;
      case "skirmish-set-submissions":
        await handleSetSubmissions(interaction);
        break;
      case "skirmish-allow":
        await handleAllow(interaction);
        break;
      case "skirmish-remove":
        await handleRemove(interaction);
        break;
      case "skirmish-reviewed":
        await handleReviewed(interaction);
        break;
      case "skirmish-list":
        await handleList(interaction);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Something went wrong handling that command.",
        ephemeral: true
      });
    }
  }
});

// ---- Command logic: radskirmish (connect + submit) ----

async function handleRadSkirmish(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "connect") {
    await handleConnect(interaction);
  } else if (sub === "submit") {
    await handleSubmit(interaction);
  }
}

async function handleConnect(interaction) {
  const userId = interaction.user.id;
  const displayName = interaction.options.getString("display_name", true).trim();

  const player = getOrCreatePlayer(userId);
  player.displayName = displayName;
  saveData(state);

  await interaction.reply({
    content: `Your Discord is now linked to **${displayName}** on the Riftbound Play Network.`,
    ephemeral: true
  });
}

async function handleSubmit(interaction) {
  const userId = interaction.user.id;
  const link = interaction.options.getString("link", true).trim();
  const player = getOrCreatePlayer(userId);

  // Require connect first
  if (!player.displayName) {
    await interaction.reply({
      content:
        "You need to connect your Discord to your Riftbound Play Network Display Name first using `/radskirmish connect <Display Name>`.",
      ephemeral: true
    });
    return;
  }

  // Require registration
  if (!player.registered) {
    await interaction.reply({
      content:
        "You are not registered for this Skirmish. If you think this is a mistake, talk to an organizer or judge.",
      ephemeral: true
    });
    return;
  }

  if (!state.submissionsChannelId) {
    await interaction.reply({
      content: "Decklist submissions channel has not been set up yet. Please ping an organizer.",
      ephemeral: true
    });
    return;
  }

  const channel = await interaction.guild.channels.fetch(state.submissionsChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "Configured submissions channel is invalid. Please ask a mod to run `/skirmish-set-submissions` again.",
      ephemeral: true
    });
    return;
  }

  // Update player state
  player.deckLink = link;
  player.deckSubmitted = true;
  player.deckReviewed = false;
  saveData(state);

  const looksLikePiltover =
    link.startsWith("https://") &&
    link.toLowerCase().includes("piltover");

  const embed = new EmbedBuilder()
    .setTitle("New Decklist Submitted")
    .setDescription(looksLikePiltover ? "Piltover Archive deck submitted." : "Deck link submitted.")
    .addFields(
      { name: "Player", value: `<@${userId}>`, inline: true },
      { name: "RPN Display Name", value: player.displayName || "_not set_", inline: true },
      { name: "Link", value: link, inline: false }
    )
    .setTimestamp(new Date())
    .setColor(0xffc857);

  await channel.send({ embeds: [embed] });

  await interaction.reply({
    content: "Decklist received. Good luck, Summoner.",
    ephemeral: true
  });
}

// ---- Mod commands ----

async function handleSetSubmissions(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to configure Skirmish settings.",
      ephemeral: true
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);

  if (channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "Please select a text channel.",
      ephemeral: true
    });
    return;
  }

  state.submissionsChannelId = channel.id;
  saveData(state);

  await interaction.reply({
    content: `Decklist submissions channel set to ${channel}.`,
    ephemeral: true
  });
}

async function handleAllow(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to modify Skirmish registrations.",
      ephemeral: true
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const player = getOrCreatePlayer(user.id);

  player.registered = true;
  saveData(state);

  await interaction.reply({
    content: `Marked <@${user.id}> as **registered** for this Summoner Skirmish.`,
    ephemeral: true
  });

  try {
    const dm = await user.createDM();
    await dm.send(
      "You have been registered for the upcoming Summoner Skirmish. " +
        "Once you connect your Riftbound Play Network Display Name with `/radskirmish connect`, " +
        "you can submit your deck with `/radskirmish submit`."
    );
  } catch {
    // Ignore DM failures
  }
}

async function handleRemove(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to modify Skirmish registrations.",
      ephemeral: true
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const player = getOrCreatePlayer(user.id);

  const wasRegistered = player.registered;
  const hadDeck = player.deckSubmitted;

  player.registered = false;
  player.deckLink = null;
  player.deckSubmitted = false;
  player.deckReviewed = false;
  saveData(state);

  await interaction.reply({
    content: `Unregistered <@${user.id}> and cleared their deck submission.${wasRegistered ? "" : " (They were not previously registered.)"}${hadDeck ? " (They had a deck submitted.)" : ""}`,
    ephemeral: true
  });

  try {
    const dm = await user.createDM();
    await dm.send(
      "You have been unregistered from the upcoming Summoner Skirmish, and your deck submission has been cleared. " +
        "If you think this is an error, please contact an organizer or judge."
    );
  } catch {
    // Ignore DM failures
  }
}

async function handleReviewed(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to mark deck reviews.",
      ephemeral: true
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const reviewed = interaction.options.getBoolean("reviewed", true);
  const player = getOrCreatePlayer(user.id);

  if (!player.deckSubmitted) {
    await interaction.reply({
      content: `<@${user.id}> has not submitted a decklist yet.`,
      ephemeral: true
    });
    return;
  }

  player.deckReviewed = reviewed;
  saveData(state);

  await interaction.reply({
    content: `Marked <@${user.id}>'s deck as **${reviewed ? "reviewed" : "not reviewed"}**.`,
    ephemeral: true
  });
}

async function handleList(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to view Skirmish lists.",
      ephemeral: true
    });
    return;
  }

  const entries = Object.entries(state.players);
  if (entries.length === 0) {
    await interaction.reply({
      content: "No players are known to the bot yet.",
      ephemeral: true
    });
    return;
  }

  // Build a simple text table
  const header = "Player | RPN Name | Deck Submitted | Deck Reviewed";
  const separator = "------ | -------- | -------------- | -------------";

  const rows = entries.map(([userId, player]) => {
    const playerLabel = `<@${userId}>`;
    const name = player.displayName || "—";
    const submitted = player.deckSubmitted ? "✅" : "❌";
    const reviewed = player.deckReviewed ? "✅" : "❌";
    return `${playerLabel} | ${name} | ${submitted} | ${reviewed}`;
  });

  const table = ["```text", header, separator, ...rows, "```"].join("\n");

  await interaction.reply({
    content: table,
    ephemeral: true
  });
}

// ---- Tiny HTTP server for Render ----

const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("RAD Event Bot is running.\n");
  })
  .listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
  });

// ---- Start bot ----

client.login(process.env.DISCORD_TOKEN);