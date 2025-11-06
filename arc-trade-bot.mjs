/* ARC Raiders Trade Bot – MVP (Railway-ready)
 * Node 18+, discord.js v14, better-sqlite3
 * 1) npm i discord.js better-sqlite3 dotenv
 * 2) .env: DISCORD_TOKEN=..., APP_ID=..., GUILD_ID=..., (optional) DB_PATH=/data/trades.db
 * 3) node arc-trade-bot.mjs
 */
import 'dotenv/config'
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits
} from 'discord.js'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'



// ---- Config ----
export const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || '45', 10);

// (optional) allow DB path override & ensure directory exists
import fs from 'node:fs';
import path from 'node:path';
const DB_PATH = process.env.DB_PATH || 'trades.db';
const dir = path.dirname(DB_PATH);
if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });


// SQLite schema
db.exec(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  message_id TEXT,
  channel_id TEXT,
  have TEXT NOT NULL,
  want TEXT NOT NULL,
  price TEXT,
  platform TEXT,
  notes TEXT,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trades_active ON trades(status, created_at);
`)

const insertTrade = db.prepare(`INSERT INTO trades(user_id, message_id, channel_id, have, want, price, platform, notes, status, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?, 'active', ?, ?)`)
const listActive = db.prepare(`SELECT * FROM trades WHERE status='active' ORDER BY created_at DESC LIMIT ? OFFSET ?`)
const listByUser = db.prepare(`SELECT * FROM trades WHERE user_id=? AND status='active' ORDER BY created_at DESC LIMIT ?`)
const markStatus = db.prepare(`UPDATE trades SET status=? WHERE id=?`)
const attachMessage = db.prepare(`UPDATE trades SET message_id=?, channel_id=? WHERE id=?`)
const findById = db.prepare(`SELECT * FROM trades WHERE id=?`)
const simpleSearch = db.prepare(`SELECT * FROM trades WHERE status='active' AND (LOWER(have) LIKE ? OR LOWER(want) LIKE ?) ORDER BY created_at DESC LIMIT 20`)
const purgeExpired = db.prepare(`UPDATE trades SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?`)

// Cooldown memory
const lastUse = new Map()
function onCooldown(userId) {
  const now = Date.now()
  const last = lastUse.get(userId) || 0
  if (now - last < COOLDOWN_SECONDS * 1000) return true
  lastUse.set(userId, now)
  return false
}

// ---------------------- Client ----------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
})

// ---------------------- Slash Commands ----------------------
const commands = [
  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Post, search, or manage ARC Raiders trades')
    .addSubcommand(sc => sc
      .setName('post')
      .setDescription('Create a trade card (have → want)')
      .addStringOption(o => o.setName('have').setDescription('What you are offering (weapon/mod/material)').setRequired(true))
      .addStringOption(o => o.setName('want').setDescription('What you want in return').setRequired(true))
      .addStringOption(o => o.setName('price').setDescription('Optional: price or terms'))
      .addStringOption(o => o.setName('platform').setDescription('Platform/server (e.g., Steam/PS, Region, Mode)'))
      .addStringOption(o => o.setName('notes').setDescription('Any extra info (rolls, tiers, caps, etc.)'))
      .addIntegerOption(o => o.setName('expires_hours').setDescription('Auto-expire after N hours (e.g., 24)'))
    )
    .addSubcommand(sc => sc
      .setName('search')
      .setDescription('Search active trades')
      .addStringOption(o => o.setName('q').setDescription('Keyword (item name, perk, etc.)').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('list')
      .setDescription('List latest active trades (or your own)')
      .addUserOption(o => o.setName('user').setDescription('Whose trades? default: you'))
    )
    .addSubcommand(sc => sc
      .setName('close')
      .setDescription('Close one of your trades by ID')
      .addIntegerOption(o => o.setName('id').setDescription('Trade ID').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('help')
      .setDescription('How the market works'))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
].map(c => c.toJSON())

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN)
  const guildId = process.env.GUILD_ID
  const appId = process.env.APP_ID
  if (!guildId || !appId) {
    console.log('Registering commands globally is disabled in MVP. Provide GUILD_ID and APP_ID for guild install.')
    return
  }
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands })
  console.log('Slash commands registered for guild:', guildId)
}

// ---------------------- Helpers ----------------------
function tradeEmbed(trade, authorTag) {
  const e = new EmbedBuilder()
    .setTitle(`HAVE → WANT`)
    .addFields(
      { name: 'Have', value: truncate(trade.have, 1024) },
      { name: 'Want', value: truncate(trade.want, 1024) },
      ...(trade.price ? [{ name: 'Price/Terms', value: truncate(trade.price, 1024) }] : []),
      ...(trade.platform ? [{ name: 'Platform/Region', value: truncate(trade.platform, 1024) }] : []),
      ...(trade.notes ? [{ name: 'Notes', value: truncate(trade.notes, 1024) }] : [])
    )
    .setFooter({ text: `#${trade.id} • ${authorTag}` })
    .setTimestamp(trade.created_at)
  return e
}

function controlsRow(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`contact:${tradeId}`).setLabel('Contact Seller').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`marktraded:${tradeId}`).setLabel('Mark as Traded').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`close:${tradeId}`).setLabel('Close').setStyle(ButtonStyle.Secondary)
  )
}

function truncate(s, n) { return (s || '').slice(0, n) }

// ---------------------- Events ----------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`)
  await registerCommands()
  // Periodic cleanup
  setInterval(() => purgeExpired.run(Date.now()), 5 * 60 * 1000)
})

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'trade') return
      const sub = interaction.options.getSubcommand()
      if (sub === 'help') return handleHelp(interaction)

      // anti-spam on actions that post/change
      if (['post', 'close'].includes(sub) && onCooldown(interaction.user.id)) {
        return interaction.reply({ ephemeral: true, content: `Slow down a bit — you can use this again in ~${COOLDOWN_SECONDS}s.` })
      }

      if (sub === 'post') return handlePost(interaction)
      if (sub === 'search') return handleSearch(interaction)
      if (sub === 'list') return handleList(interaction)
      if (sub === 'close') return handleClose(interaction)
    } else if (interaction.isButton()) {
      const [action, idStr] = interaction.customId.split(':')
      const id = Number(idStr)
      const trade = findById.get(id)
      if (!trade) return interaction.reply({ ephemeral: true, content: 'Trade not found (maybe closed/expired).' })

      if (action === 'contact') {
        try {
          const seller = await client.users.fetch(trade.user_id)
          const buyer = interaction.user
          await buyer.send(`You contacted **${seller.tag}** about trade #${trade.id}. Please discuss details here. ⚠️ Avoid upfront payments; use safe in-game trades.`)
          await seller.send(`**${buyer.tag}** is interested in your trade #${trade.id}:
Have: ${trade.have}
Want: ${trade.want}`)
          return interaction.reply({ ephemeral: true, content: 'Opened a DM with the seller. Trade safely!' })
        } catch (e) {
          return interaction.reply({ ephemeral: true, content: 'Could not open DMs. The user may have DMs disabled.' })
        }
      }

      if (action === 'marktraded') {
        if (interaction.user.id !== trade.user_id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply({ ephemeral: true, content: 'Only the seller or a mod can mark this traded.' })
        }
        markStatus.run('traded', id)
        await interaction.update({ components: [], embeds: [new EmbedBuilder().setDescription(`✅ Trade #${id} marked as **TRADED**`).setTimestamp(Date.now())] })
        return
      }

      if (action === 'close') {
        if (interaction.user.id !== trade.user_id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply({ ephemeral: true, content: 'Only the seller or a mod can close this.' })
        }
        markStatus.run('closed', id)
        await interaction.update({ components: [], embeds: [new EmbedBuilder().setDescription(`🛑 Trade #${id} **CLOSED**`).setTimestamp(Date.now())] })
        return
      }
    }
  } catch (err) {
    console.error(err)
    if (interaction.isRepliable()) {
      return interaction.reply({ ephemeral: true, content: 'Something went wrong. Try again in a moment.' }).catch(() => {})
    }
  }
})

// ---------------------- Handlers ----------------------
async function handleHelp(interaction) {
  const text = [
    '**ARC Raiders Trade Market – How it works**',
    '• Use **/trade post** to publish a card (HAVE → WANT).',
    '• Use **/trade search q:** to find items/perks quickly.',
    '• Use **/trade list** to see your cards or the latest ones.',
    '• Buttons let you contact seller, close, or mark traded.',
    '• Mods can close/mark any card; posts can auto-expire.',
    'Safety: avoid upfront payments; trade in-game; report scammers to mods.'
  ].join('\n')
  await interaction.reply({ ephemeral: true, content: text })
}

async function handlePost(interaction) {
  const have = interaction.options.getString('have', true).trim()
  const want = interaction.options.getString('want', true).trim()
  const price = interaction.options.getString('price')?.trim() || null
  const platform = interaction.options.getString('platform')?.trim() || null
  const notes = interaction.options.getString('notes')?.trim() || null
  const expiresHours = interaction.options.getInteger('expires_hours')

  const createdAt = Date.now()
  const expiresAt = expiresHours ? createdAt + expiresHours * 3600 * 1000 : null

  const info = insertTrade.run(
    interaction.user.id, null, interaction.channelId, have, want, price, platform, notes, createdAt, expiresAt
  )
  const id = info.lastInsertRowid

  const embed = tradeEmbed({ id, have, want, price, platform, notes, created_at: createdAt }, interaction.user.tag)
  const msg = await interaction.reply({
    embeds: [embed],
    components: [controlsRow(id)],
    fetchReply: true
  })
  attachMessage.run(msg.id, msg.channelId, id)
}

async function handleSearch(interaction) {
  const q = interaction.options.getString('q', true).toLowerCase().trim()
  purgeExpired.run(Date.now())
  const results = simpleSearch.all(`%${q}%`, `%${q}%`)
  if (!results.length) return interaction.reply({ ephemeral: true, content: 'No active trades matched your search.' })

  const lines = results.map(t => `#${t.id} • **Have:** ${boldCut(t.have)} → **Want:** ${boldCut(t.want)} ${t.price ? `• ${t.price}` : ''}`)
  const chunks = chunkLines(lines, 10)
  await interaction.reply({ ephemeral: true, content: `Found **${results.length}** matches:\n\n${chunks[0]}` })
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ ephemeral: true, content: chunks[i] })
  }
}

async function handleList(interaction) {
  purgeExpired.run(Date.now())
  const user = interaction.options.getUser('user') || interaction.user
  const my = user.id === interaction.user.id
  const rows = my ? listByUser.all(user.id, 20) : listActive.all(20, 0)
  if (!rows.length) return interaction.reply({ ephemeral: true, content: my ? 'You have no active trades.' : 'No active trades yet.' })

  const lines = rows.map(t => `#${t.id} • <@${t.user_id}> • **Have:** ${boldCut(t.have)} → **Want:** ${boldCut(t.want)} ${t.price ? `• ${t.price}` : ''}`)
  const chunks = chunkLines(lines, 10)
  await interaction.reply({ ephemeral: true, content: chunks[0] })
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ ephemeral: true, content: chunks[i] })
  }
}

async function handleClose(interaction) {
  const id = interaction.options.getInteger('id', true)
  const trade = findById.get(id)
  if (!trade) return interaction.reply({ ephemeral: true, content: 'Trade not found.' })
  if (interaction.user.id !== trade.user_id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.reply({ ephemeral: true, content: 'Only the seller or a mod can close this.' })
  }
  markStatus.run('closed', id)
  await interaction.reply({ ephemeral: true, content: `Closed trade #${id}.` })
}

function boldCut(s) { return `**${truncate(s, 80)}**` }
function chunkLines(arr, per = 10) {
  const out = []
  for (let i = 0; i < arr.length; i += per) out.push(arr.slice(i, i + per).join('\n'))
  return out
}

// ---------------------- Login ----------------------
if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env / Railway Variables')
  process.exit(1)
}
client.login(process.env.DISCORD_TOKEN)

// ---------------------- Notes ----------------------
// • Give the bot permissions: applications.commands, bot (Send Messages, Manage Messages recommended for mods).
// • Create a dedicated #trade-market channel and tell users to use /trade post there.
// • Extend with: reputation scores, escrow-ish mod assistance, image attachments, per-item taxonomies, and auto-thread per card.
