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
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const fs = require("fs");
const path = require("path");

// ---- Basic config ----

// Optional: role IDs allowed to run mod commands in addition to Manage Guild permission.
const MOD_ROLE_IDS = [
  // "1431337802368417854"
];

// Path for persistent data
const DATA_PATH = path.join(__dirname, "skirmish-data.json");

// ---- Types / defaults ----

function createEmptyPlayer() {
  return {
    displayName: null,
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

    const players = parsed.players && typeof parsed.players === "object"
      ? parsed.players
      : {};

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
  new SlashCommandBuilder()
    .setName("skirmish")
    .setDescription("Skirmish tools: connect, submit, list, and manage decklists.")
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
        .setDescription("Submit your Piltover Archive deck link for this Summoner Skirmish.")
        .addStringOption(opt =>
          opt
            .setName("link")
            .setDescription("Piltover Archive deck link")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("setsubmissions")
        .setDescription("Set the channel where decklists will be posted. (Mods only)")
        .addChannelOption(opt =>
          opt
            .setName("channel")
            .setDescription("Channel for decklist submissions")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("list")
        .setDescription("Show all known players and their deck submission / review status. (Mods only)")
    )
    .addSubcommand(sub =>
      sub
        .setName("reviewed")
        .setDescription("Mark whether a player's decklist has been reviewed. (Mods only)")
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
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("remove")
        .setDescription("Clear a player's deck submission. (Mods only)")
        .addUserOption(opt =>
          opt
            .setName("user")
            .setDescription("Player to remove submission for")
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("clear")
        .setDescription("Clear ALL tracked Skirmish submissions. (Mods only)")
    )
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
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "skirmish") return;

      const sub = interaction.options.getSubcommand();

      switch (sub) {
        case "connect":
          await handleConnect(interaction);
          break;
        case "submit":
          await handleSubmit(interaction);
          break;
        case "setsubmissions":
          await handleSetSubmissions(interaction);
          break;
        case "list":
          await handleList(interaction);
          break;
        case "reviewed":
          await handleReviewed(interaction);
          break;
        case "remove":
          await handleRemove(interaction);
          break;
        case "clear":
          await handleClear(interaction);
          break;
        default:
          break;
      }
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Something went wrong handling that interaction.",
        ephemeral: true
      });
    }
  }
});

// ---- Player-facing logic ----

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

  if (!player.displayName) {
    await interaction.reply({
      content:
        "You need to connect your Discord to your Riftbound Play Network Display Name first using `/skirmish connect <Display Name>`.",
      ephemeral: true
    });
    return;
  }

  if (!state.submissionsChannelId) {
    await interaction.reply({
      content: "Decklist submissions channel has not been set up yet. Please talk to an organizer or judge.",
      ephemeral: true
    });
    return;
  }

  const channel = await interaction.guild.channels.fetch(state.submissionsChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "Configured submissions channel is invalid. Please ask an organizer to run `/skirmish setsubmissions` again.",
      ephemeral: true
    });
    return;
  }

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
      content: `${user} has not submitted a decklist yet.`,
      ephemeral: true
    });
    return;
  }

  player.deckReviewed = reviewed;
  saveData(state);

  await interaction.reply({
    content: `Marked ${user}'s deck as **${reviewed ? "reviewed" : "not reviewed"}**.`,
    ephemeral: true
  });
}

async function handleRemove(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to modify Skirmish submissions.",
      ephemeral: true
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const player = getOrCreatePlayer(user.id);

  const hadDeck = player.deckSubmitted || !!player.deckLink;

  player.deckLink = null;
  player.deckSubmitted = false;
  player.deckReviewed = false;
  saveData(state);

  await interaction.reply({
    content: hadDeck
      ? `Cleared deck submission for ${user}.`
      : `${user} did not have a deck submission recorded.`,
    ephemeral: true
  });
}

// /skirmish clear – ask for confirmation with buttons
async function handleClear(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to clear Skirmish data.",
      ephemeral: true
    });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`skirmish_clear_confirm_${interaction.user.id}`)
      .setLabel("Confirm")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`skirmish_clear_cancel_${interaction.user.id}`)
      .setLabel("Cancel")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({
    content:
      "This will clear **all tracked players and deck submissions** for the current Skirmish.\nAre you sure you want to do this?",
    components: [row],
    ephemeral: true
  });
}

// Handle clear confirmation buttons
async function handleButton(interaction) {
  const id = interaction.customId;

  if (!id.startsWith("skirmish_clear_")) return;

  const parts = id.split("_"); // ["skirmish","clear","confirm","<userId>"]
  const action = parts[2];
  const ownerId = parts[3];

  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: "You didn’t start this clear action.",
      ephemeral: true
    });
    return;
  }

  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to clear Skirmish data.",
      ephemeral: true
    });
    return;
  }

  if (action === "confirm") {
    state.players = {};
    saveData(state);

    await interaction.update({
      content: "All tracked Skirmish players and deck submissions have been cleared.",
      components: []
    });
  } else if (action === "cancel") {
    await interaction.update({
      content: "Clear action cancelled.",
      components: []
    });
  }
}

// /skirmish list – show overview, with link on the right and no previews
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

  const lines = [];

  for (const [userId, player] of entries) {
    let displayName = `ID: ${userId}`;
    let mention = `<@${userId}>`;

    // Try to get the user's current display name in the guild
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (member) {
      displayName = member.displayName;
      mention = member.toString(); // proper @name mention
    }

    const rpn = player.displayName || "—";
    const submitted = player.deckSubmitted ? "✅" : "❌";
    const reviewed = player.deckReviewed ? "✅" : "❌";
    const linkDisplay = player.deckLink ? `\`${player.deckLink}\`` : "—"; // code formatting to suppress preview

    lines.push(
      `${mention} (${rpn}) | Submitted: ${submitted} | Reviewed: ${reviewed} | Link: ${linkDisplay}`
    );
  }

  const message = [
    "**Summoner Skirmish Deck Overview**",
    "",
    lines.join("\n")
  ].join("\n");

  await interaction.reply({
    content: message,
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
