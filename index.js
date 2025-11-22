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

// ---- Data helpers ----

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);

    return {
      submissionsChannelId: parsed.submissionsChannelId ?? null,
      allowedUserIds: Array.isArray(parsed.allowedUserIds) ? parsed.allowedUserIds : [],
      pendingUserIds: Array.isArray(parsed.pendingUserIds) ? parsed.pendingUserIds : []
    };
  } catch (err) {
    return {
      submissionsChannelId: null,
      allowedUserIds: [],
      pendingUserIds: []
    };
  }
}

function saveData(data) {
  const safe = {
    submissionsChannelId: data.submissionsChannelId ?? null,
    allowedUserIds: Array.isArray(data.allowedUserIds) ? data.allowedUserIds : [],
    pendingUserIds: Array.isArray(data.pendingUserIds) ? data.pendingUserIds : []
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(safe, null, 2), "utf8");
}

let state = loadData();

// ---- Discord client ----

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

// ---- Slash command definitions ----

const commands = [
  new SlashCommandBuilder()
    .setName("radskirmish")
    .setDescription("Submit your Piltover deck link for this Summoner Skirmish.")
    .addStringOption(opt =>
      opt
        .setName("link")
        .setDescription("Piltover Archive deck link")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skirmish-register")
    .setDescription("Request to register for the next Summoner Skirmish."),

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

  new SlashCommandBuilder()
    .setName("skirmish-approve")
    .setDescription("Approve a player for this Summoner Skirmish.")
    .addUserOption(opt =>
      opt
        .setName("user")
        .setDescription("Player to approve")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skirmish-deny")
    .setDescription("Deny a player / remove them from this Skirmish.")
    .addUserOption(opt =>
      opt
        .setName("user")
        .setDescription("Player to deny / remove")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skirmish-list")
    .setDescription("Show registered and pending players.")
].map(cmd => cmd.toJSON());

// ---- Command registration ----

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.GUILD_ID || null;

  try {
    if (!clientId) {
      console.error("DISCORD_CLIENT_ID is not set in .env – cannot register commands.");
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
      case "skirmish-register":
        await handleRegister(interaction);
        break;
      case "skirmish-set-submissions":
        await handleSetSubmissions(interaction);
        break;
      case "skirmish-approve":
        await handleApprove(interaction);
        break;
      case "skirmish-deny":
        await handleDeny(interaction);
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

// ---- Command logic ----

async function handleRadSkirmish(interaction) {
  const userId = interaction.user.id;
  const link = interaction.options.getString("link", true);

  if (!state.allowedUserIds.includes(userId)) {
    await interaction.reply({
      content: "You are not registered for this Skirmish.\nIf you think this is a mistake, try `/skirmish-register` or talk to a mod.",
      ephemeral: true
    });
    return;
  }

  if (!state.submissionsChannelId) {
    await interaction.reply({
      content: "Decklist submissions channel has not been set up yet. Please ping a mod.",
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

  const looksLikePiltover =
    link.startsWith("https://") &&
    link.toLowerCase().includes("piltover");

  const embed = new EmbedBuilder()
    .setTitle("New Decklist Submitted")
    .setDescription(looksLikePiltover ? "Piltover Archive deck submitted." : "Deck link submitted.")
    .addFields(
      { name: "Player", value: `<@${userId}>`, inline: true },
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

async function handleRegister(interaction) {
  const userId = interaction.user.id;

  if (state.allowedUserIds.includes(userId)) {
    await interaction.reply({
      content: "You’re already registered for this Skirmish.",
      ephemeral: true
    });
    return;
  }

  if (state.pendingUserIds.includes(userId)) {
    await interaction.reply({
      content: "Your registration is already pending approval.",
      ephemeral: true
    });
    return;
  }

  state.pendingUserIds.push(userId);
  saveData(state);

  await interaction.reply({
    content:
      "Registration request sent. A mod will approve you if there’s space.\nYou’ll be able to submit your decklist with `/radskirmish` once approved.",
    ephemeral: true
  });

  if (state.submissionsChannelId) {
    const channel = await interaction.guild.channels.fetch(state.submissionsChannelId).catch(() => null);
    if (channel && channel.type === ChannelType.GuildText) {
      await channel.send(
        `📝 **New registration request:** <@${userId}> wants to join the next Summoner Skirmish.\nMods can use \`/skirmish-approve\` or \`/skirmish-deny\`.`
      );
    }
  }
}

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

async function handleApprove(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to approve players.",
      ephemeral: true
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const userId = user.id;

  const wasPending = state.pendingUserIds.includes(userId);
  state.pendingUserIds = state.pendingUserIds.filter(id => id !== userId);

  if (!state.allowedUserIds.includes(userId)) {
    state.allowedUserIds.push(userId);
  }

  saveData(state);

  await interaction.reply({
    content: `Approved <@${userId}> for this Summoner Skirmish.${wasPending ? " (They were in the pending queue.)" : ""}`,
    ephemeral: true
  });

  try {
    const dm = await user.createDM();
    await dm.send(
      "You’ve been approved for the upcoming Summoner Skirmish.\nYou can now submit your decklist with `/radskirmish <link>` in the server."
    );
  } catch {
  }
}

async function handleDeny(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to deny players.",
      ephemeral: true
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const userId = user.id;

  const wasPending = state.pendingUserIds.includes(userId);
  const wasAllowed = state.allowedUserIds.includes(userId);

  state.pendingUserIds = state.pendingUserIds.filter(id => id !== userId);
  state.allowedUserIds = state.allowedUserIds.filter(id => id !== userId);
  saveData(state);

  if (!wasPending && !wasAllowed) {
    await interaction.reply({
      content: `<@${userId}> was not in the pending or allowed lists.`,
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: `Removed <@${userId}> from this Summoner Skirmish.${wasPending ? " (They were pending.)" : ""}${wasAllowed ? " (They were previously approved.)" : ""}`,
    ephemeral: true
  });

  try {
    const dm = await user.createDM();
    await dm.send(
      "Your registration for the upcoming Summoner Skirmish was declined or removed. " +
        "If you think this is an error, please contact a moderator."
    );
  } catch {
  }
}

async function handleList(interaction) {
  if (!isMod(interaction)) {
    await interaction.reply({
      content: "You don’t have permission to view the Skirmish lists.",
      ephemeral: true
    });
    return;
  }

  const allowed = state.allowedUserIds.map(id => `<@${id}>`).join("\n") || "_none_";
  const pending = state.pendingUserIds.map(id => `<@${id}>`).join("\n") || "_none_";

  const embed = new EmbedBuilder()
    .setTitle("Summoner Skirmish Registration")
    .addFields(
      { name: "Approved players", value: allowed, inline: false },
      { name: "Pending requests", value: pending, inline: false }
    )
    .setColor(0x6a4c93)
    .setTimestamp(new Date());

  await interaction.reply({
    embeds: [embed],
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