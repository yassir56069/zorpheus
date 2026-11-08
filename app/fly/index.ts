import http from 'node:http';
import {
    Client, GatewayIntentBits, Events, MessageFlags, type Message,
} from 'discord.js';
import { getUserLastFM, getUserLastFMSessionKey, saveLastFMSessionKey } from '@/utils/database/user-service';
import { getSessionKey, loveTrack } from '@/utils/lastfm-auth';
import { buildFmReply } from './commands/fm/fm-core';
import { getBaseUrl } from './commands/fm/fm-helpers';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged: enable in the Developer Portal
    ],
});

const NOT_REGISTERED =
    "You haven't registered your Last.fm username yet! Use the `/join` command first, or provide a username directly with `/fm username: <username>` or `.fm <username>`.";

const expireButtons = (msg: Message) =>
    setTimeout(() => msg.edit({ components: [] }).catch(() => {}), 60_000);

client.once(Events.ClientReady, c => console.log(`Logged in as ${c.user.tag}`));

//#region .fm prefix
client.on(Events.MessageCreate, async msg => {
    if (msg.author.bot || !msg.guild) return;
    const m = msg.content.match(/^\.fm(?:\s+(\S+))?\s*$/i);
    if (!m) return;

    const noPing = { repliedUser: false };
    const username = m[1] ?? ((await getUserLastFM(msg.author.id)) as string | null);
    if (!username) {
        await msg.reply({ content: NOT_REGISTERED, allowedMentions: noPing });
        return;
    }

    try {
        if ('sendTyping' in msg.channel) await msg.channel.sendTyping();
        const r = await buildFmReply({ lastfmUsername: username, discordUserId: msg.author.id, applyYoutubeFix: true });
        if (!r.ok) {
            await msg.reply({ content: r.message, allowedMentions: noPing });
            return;
        }
        const sent = await msg.reply({ embeds: r.embeds, components: r.components, allowedMentions: noPing });
        expireButtons(sent);
    } catch (e) {
        console.error('[.fm]', e);
        await msg.reply({ content: 'An error occurred while fetching data from Last.fm.', allowedMentions: noPing }).catch(() => {});
    }
});
//#endregion

client.on(Events.InteractionCreate, async i => {
    //#region /fm
    if (i.isChatInputCommand() && i.commandName === 'fm') {
        const username = i.options.getString('username') ?? ((await getUserLastFM(i.user.id)) as string | null);
        if (!username) {
            await i.reply({ content: NOT_REGISTERED, flags: MessageFlags.Ephemeral });
            return;
        }
        await i.deferReply();
        try {
            const r = await buildFmReply({
                lastfmUsername: username,
                discordUserId: i.user.id,
                applyYoutubeFix: i.options.getBoolean('youtube_scrobble') !== false,
            });
            if (!r.ok) { await i.editReply({ content: r.message }); return; }
            const sent = await i.editReply({ embeds: r.embeds, components: r.components });
            expireButtons(sent);
        } catch (e) {
            console.error('[/fm]', e);
            await i.editReply({ content: 'An error occurred while fetching data from Last.fm.' });
        }
        return;
    }
    //#endregion

    if (!i.isButton()) return;

    //#region Re-sync
    if (i.customId.startsWith('resync_fm_')) {
        const ownerId = i.customId.split('_')[2];
        if (i.user.id !== ownerId) {
            await i.reply({ content: "This button isn't for you!", flags: MessageFlags.Ephemeral });
            return;
        }
        await i.deferUpdate();
        try {
            const username = (await getUserLastFM(i.user.id)) as string | null;
            if (!username) {
                await i.editReply({ content: "It seems you're no longer registered. Please use `/join`.", embeds: [], components: [] });
                return;
            }
            const r = await buildFmReply({ lastfmUsername: username, discordUserId: i.user.id, applyYoutubeFix: true });
            if (!r.ok) { await i.editReply({ content: r.message, embeds: [] }); return; }
            await i.editReply({ content: '', embeds: r.embeds, components: r.components });
        } catch (e) {
            console.error('[resync]', e);
            await i.editReply({ content: 'An error occurred while re-syncing from Last.fm.' });
        }
        return;
    }
    //#endregion

    //#region Love
    if (i.customId.startsWith('love_fm_')) {
        const rest = i.customId.replace('love_fm_', '');
        const idx = rest.indexOf('_');
        const ownerId = rest.substring(0, idx);
        const payload = rest.substring(idx + 1);

        if (i.user.id !== ownerId) {
            await i.reply({ content: "This button isn't for you!", flags: MessageFlags.Ephemeral });
            return;
        }
        const sep = payload.indexOf('||');
        const artist = sep !== -1 ? payload.substring(0, sep) : payload;
        const trackName = sep !== -1 ? payload.substring(sep + 2) : '';

        const sessionKey = await getUserLastFMSessionKey(i.user.id);
        if (!sessionKey) {
            const cb = encodeURIComponent(
                `${getBaseUrl()}/api/lastfm-callback?state=${i.user.id}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(trackName)}`
            );
            const authUrl = `https://www.last.fm/api/auth/?api_key=${process.env.LASTFM_API_KEY}&cb=${cb}`;
            await i.reply({
                content: `🔐 To love tracks on Last.fm, you need to connect your account once.\n\n**[Click here to authorize →](<${authUrl}>)**\n\nAfter authorizing, **${trackName}** by **${artist}** will be loved automatically and future 🖤 presses will work instantly.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await i.deferUpdate();
        try {
            await loveTrack(artist, trackName, sessionKey);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rows = (i.message.components as any[]).map(row => {
                const json = row.toJSON();
                json.components = json.components.map((c: { custom_id?: string; label?: string }) =>
                    c.custom_id === i.customId ? { ...c, label: '❤️' } : c);
                return json;
            });
            await i.editReply({ components: rows });
        } catch (e) {
            console.error('[Love Track Error]', e);
            await i.followUp({
                content: '❌ Failed to love the track. Your session may have expired, press 🖤 again to re-authenticate.',
                flags: MessageFlags.Ephemeral,
            });
        }
    }
    //#endregion
});

//#region HTTP: health check + Last.fm OAuth callback
const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const page = (color: string, body: string) =>
    `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4rem;background:#111;color:${color}">${body}</body></html>`;

async function lastfmCallback(url: URL, res: http.ServerResponse) {
    const token = url.searchParams.get('token');
    const userId = url.searchParams.get('state');
    const artist = url.searchParams.get('artist');
    const track = url.searchParams.get('track');

    if (!token || !userId) { res.writeHead(400).end('Missing token or state'); return; }

    try {
        const sessionKey = await getSessionKey(token);
        await saveLastFMSessionKey(userId, sessionKey);
        if (artist && track) await loveTrack(artist, track, sessionKey);

        client.users.fetch(userId)
            .then(u => u.send(
                artist && track
                    ? `✅ Your Last.fm account is now connected! **${track}** by **${artist}** has been loved. Future 🖤 presses will work instantly.`
                    : '✅ Your Last.fm account is now connected! Future 🖤 presses will work instantly.'))
            .catch(e => console.error('[callback DM]', e));

        res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('#fff',
            `<h1>✅ Connected!</h1><p>${artist && track ? `<strong>${esc(track)}</strong> has been loved on Last.fm.<br><br>` : ''}Your Last.fm account is now linked. You can close this tab.</p>`));
    } catch (e) {
        console.error('[Last.fm OAuth Callback Error]', e);
        res.writeHead(500, { 'Content-Type': 'text/html' }).end(page('#ff4444',
            '<h1>❌ Something went wrong</h1><p>Could not connect your Last.fm account. Please try again.</p>'));
    }
}

http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/healthz') { res.writeHead(200).end('ok'); return; }
    if (url.pathname === '/api/lastfm-callback') { void lastfmCallback(url, res); return; }
    res.writeHead(404).end();
}).listen(8080, () => console.log('HTTP listening on :8080'));
//#endregion

client.login(process.env.DISCORD_BOT_TOKEN);