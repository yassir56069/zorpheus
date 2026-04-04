// app/commands/fm.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    APIMessageComponentButtonInteraction,
    ButtonStyle,
    APIApplicationCommandInteractionDataBooleanOption,
} from 'discord-api-types/v10';
import { getUserLastFM, getUserLastFMSessionKey } from '@/utils/database/user-service';
import { Vibrant } from 'node-vibrant/node';

// --- NEW IMPORTS ---
import { syncAlbumCover, generateSlug } from '@/utils/database/album-service';
import { linkAlbumGenres } from '@/utils/database/genre-service';
import { loveTrack } from '@/utils/lastfm-auth';

//#region Helper Functions

function cleanArtistName(artist: string): string {
    console.log(`[Artist Filter] Executing. Original artist: "${artist}"`);
    const topicPattern = /\s-\sTopic\s*-?$/i;

    if (topicPattern.test(artist)) {
        const cleanedArtist = artist.replace(topicPattern, '').trim();
        console.log(`[Artist Filter] Pattern matched. Cleaned artist to: "${cleanedArtist}"`);
        return cleanedArtist;
    } else {
        console.log(`[Artist Filter] Pattern did not match. No changes made.`);
        return artist;
    }
}

async function isValidImageUrl(url: string | null | undefined, timeout = 2500): Promise<boolean> {
    if (!url) {
        return false;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        return response.ok;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            console.log(`Image URL timed out: ${url}`);
        } else {
            console.error(`Error fetching image URL head: ${url}`, error);
        }
        return false;
    }
}

async function findCoverOnMusicBrainz(artist: string, album: string): Promise<string | null> {  
    const userAgent = process.env.MUSICBRAINZ_USER_AGENT;
    if (!userAgent) {
        console.log("MusicBrainz User-Agent not set, skipping this fallback.");
        return null;
    }
    try {
        const musicBrainzUrl = `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(album)}%20AND%20artist:${encodeURIComponent(artist)}&fmt=json`;
        const mbResponse = await fetch(musicBrainzUrl, { headers: { 'User-Agent': userAgent } });
        if (!mbResponse.ok) return null;
        
        const mbData = await mbResponse.json();
        const release = mbData.releases?.[0];
        const releaseId = release?.id;
        
        if (!releaseId) return null;
        
        const coverArtUrl = `https://coverartarchive.org/release/${releaseId}`;
        const caResponse = await fetch(coverArtUrl);
        if (!caResponse.ok) return null;
        
        const caData = await caResponse.json();
        const frontImage = caData.images?.find((img: { front: boolean; }) => img.front);
        
        if (frontImage?.image) {
            console.log("Successfully got album art from Cover Art Archive.");
            return frontImage.image;
        }
    } catch (error) {
        console.error("Error fetching from MusicBrainz/Cover Art Archive:", error);
    }
    return null;
}

async function findCoverArt(artist: string, album: string): Promise<string | null> {
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
        const response = await fetch(itunesUrl);
        const data = await response.json();
        if (data.resultCount > 0) {
            const bestMatch = data.results.find((r: { collectionName: string; }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];
            const highResUrl = bestMatch.artworkUrl100.replace('100x100', '1000x1000');
            console.log(`Successfully got album art from iTunes. ${highResUrl}`);
            return highResUrl;
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }

    console.log("iTunes failed, trying MusicBrainz / Cover Art Archive...");
    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (musicBrainzArt) return musicBrainzArt;

    console.log("All fallbacks failed.");
    return null;
}

async function getDominantColor(imageUrl: string): Promise<number | null> {
    try {
        const palette = await Vibrant.from(imageUrl).getPalette();
        const vibrantSwatch = palette.Vibrant || palette.Muted || palette.LightVibrant;
        if (vibrantSwatch && vibrantSwatch.hex) {
            return parseInt(vibrantSwatch.hex.substring(1), 16);
        }
    } catch (error) {
        console.error("Error getting dominant color:", error);
    }
    return null;
}

const getBaseUrl = () => {
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:2999';
};


// Lastfm LOVE
// custom_id max is 100 chars. Prefix "love_fm_" = 8, userId max = 20, separator = 1 -> 71 chars left for artist||track
function encodeLoveId(userId: string, artist: string, track: string): string {
    const prefix = `love_fm_${userId}_`;
    const maxPayload = 99 - prefix.length; // leave 1 char buffer
    let payload = `${artist}||${track}`;
    if (payload.length > maxPayload) {
        payload = payload.substring(0, maxPayload);
    }
    return `${prefix}${payload}`;
}

//#endregion

// --- MAIN COMMAND HANDLER ---

export async function handleFm(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ??[];
    const usernameOption = options.find(opt => opt.name === 'username') as APIApplicationCommandInteractionDataStringOption | undefined;
    const youtubeScrobbleOption = options.find(opt => opt.name === 'youtube_scrobble') as APIApplicationCommandInteractionDataBooleanOption | undefined;
    const applyYoutubeScrobbleFix = youtubeScrobbleOption?.value !== false;

    let lastfmUsername: string | null = null;
    const discordUserId = interaction.member!.user.id;
    
    if (usernameOption) {
        lastfmUsername = usernameOption.value;
    } else {
        lastfmUsername = await getUserLastFM(discordUserId) as string | null;
    }

    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/join\` command first, or provide a username directly with \`/fm username: <username>\`.`,
                flags: 1 << 6,
            },
        });
    }

    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
    
    try {
        console.log(`Fetching last track for ${lastfmUsername}...`);
        const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
            await fetch(webhookUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` }),
            });
            return new NextResponse(null, { status: 204 });
        }

        const track = data.recenttracks.track[0];
        let artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];
        
        if (applyYoutubeScrobbleFix){
            artist = cleanArtistName(artist);
        }

        let formattedDuration = "";
        try {
            const trackInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(trackName)}&format=json`;
            const trackInfoResponse = await fetch(trackInfoUrl);
            const trackInfoData = await trackInfoResponse.json();
            const durationMs = trackInfoData?.track?.duration;
            if (durationMs && parseInt(durationMs) > 0) {
                const durationSeconds = Math.floor(parseInt(durationMs) / 1000);
                const minutes = Math.floor(durationSeconds / 60);
                const seconds = durationSeconds % 60;
                formattedDuration = `-# ⏱ (${minutes}:${seconds.toString().padStart(2, '0')})`;
            }
        } catch (e) {
            console.error("Could not fetch track duration:", e);
        }

        // --- NEW: FETCH ALBUM TAGS FOR GENRES ---
        let lastfmTags: string[] =[];
        if (albumName) {
            try {
                const albumInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(albumName)}&format=json`;
                const albumInfoResponse = await fetch(albumInfoUrl);
                const albumInfoData = await albumInfoResponse.json();
                
                if (albumInfoData?.album?.tags?.tag) {
                    const tags = albumInfoData.album.tags.tag;
                    if (Array.isArray(tags)) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        lastfmTags = tags.map((t: any) => t.name);
                    } else if (typeof tags === 'object' && tags !== null) {
                        lastfmTags = [tags.name]; // If there's only 1 tag, Last.fm returns an object instead of an Array
                    }
                }
            } catch (e) {
                console.error("Could not fetch album tags:", e);
            }
        }

        let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
            || track.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
            || track.image[track.image.length - 1]?.['#text'];

        if (!await isValidImageUrl(albumArtUrl) || albumArtUrl.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
            console.log('Last.fm URL is invalid, placeholder, or timed out. Trying fallbacks...');
            albumArtUrl = await findCoverArt(artist, albumName);
        }

        if (!albumArtUrl) {
            await fetch(webhookUrl, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find album art for **${trackName}** by **${artist}**.` }),
                headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        if (discordUserId != '508817156847173632') { // ban sarsparilla!!!
            syncAlbumCover(artist, albumName, albumArtUrl, interaction.member!.user.id);
            
            // --- NEW: LINK GENRES ASYNC ---
            if (lastfmTags.length > 0) {
                const slug = generateSlug(artist, albumName);
                linkAlbumGenres(slug, lastfmTags, interaction.member!.user.id);
            }
        }

        const dominantColor = await getDominantColor(albumArtUrl);
        const baseUrl = getBaseUrl();
        let iconUrl = 'https://www.last.fm/static/images/lastfm_avatar_twitter.52a5d69a85ac.png';
        if (dominantColor) {
            const hexColor = dominantColor.toString(16).padStart(6, '0');
            iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
        }
        
        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;
        const minTitleLength = 20;
        const paddingChar = '⠀';
        const paddingNeeded = Math.max(0, minTitleLength - trackName.length);
        const padding = paddingChar.repeat(paddingNeeded);
        const paddedTitle = trackName + padding;

        const embed = {
            title: paddedTitle,
            description: `${artist} •  ${albumName} \n${formattedDuration}`,
            color: dominantColor || 0xd51007,
            thumbnail: { url: albumArtUrl },
            footer: { text: footerText, icon_url: iconUrl },
        };

        const loveCustomId = encodeLoveId(interaction.member!.user.id, artist, trackName);
        const components = [{
            type: 1,
            components: [
                {
                    type: 2,
                    style: ButtonStyle.Secondary,
                    label: 'Re-sync',
                    custom_id: `resync_fm_${interaction.member!.user.id}`,
                },
                {
                    type: 2,
                    style: ButtonStyle.Secondary,
                    label: '🖤',
                    custom_id: loveCustomId,
                },
            ],
        }];
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed], components }),
        });

        setTimeout(async () => {
            await fetch(webhookUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ components:[] }),
            });
        }, 60000);

    } catch (error) {
        console.error(error);
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'An error occurred while fetching data from Last.fm.' }),
        });
    }

    return new NextResponse(null, { status: 204 });
};

// --- BUTTON HANDLER ---

export async function handleFmResync(interaction: APIMessageComponentButtonInteraction) {
    const originalUserId = interaction.data.custom_id.split('_')[2];

    if (interaction.member!.user.id !== originalUserId) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "This button isn't for you!",
                flags: 1 << 6,
            },
        });
    }

    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: InteractionResponseType.DeferredMessageUpdate }),
    });

    const discordUserId = interaction.member!.user.id;
    const lastfmUsername = await getUserLastFM(discordUserId) as string | null;
    const apiKey = process.env.LASTFM_API_KEY;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

    if (!lastfmUsername) {
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: "It seems you're no longer registered. Please use `/register`.", embeds: [], components:[] }),
        });
        return new NextResponse(null, { status: 204 });
    }

    try {
        const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
            await fetch(webhookUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`.`, embeds:[] }),
            });
            return new NextResponse(null, { status: 204 });
        }

        const track = data.recenttracks.track[0];
        let artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];

        artist = cleanArtistName(artist);
        
        let formattedDuration = "";
        try {
            const trackInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(trackName)}&format=json`;
            const trackInfoResponse = await fetch(trackInfoUrl);
            const trackInfoData = await trackInfoResponse.json();
            const durationMs = trackInfoData?.track?.duration;
            if (durationMs && parseInt(durationMs) > 0) {
                const durationSeconds = Math.floor(parseInt(durationMs) / 1000);
                const minutes = Math.floor(durationSeconds / 60);
                const seconds = durationSeconds % 60;
                formattedDuration = `-# ⏱ (${minutes}:${seconds.toString().padStart(2, '0')})`;
            }
        } catch (e) {
            console.error("Could not fetch track duration:", e);
        }

        // --- NEW: FETCH ALBUM TAGS FOR GENRES ---
        let lastfmTags: string[] =[];
        if (albumName) {
            try {
                const albumInfoUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(albumName)}&format=json`;
                const albumInfoResponse = await fetch(albumInfoUrl);
                const albumInfoData = await albumInfoResponse.json();
                
                if (albumInfoData?.album?.tags?.tag) {
                    const tags = albumInfoData.album.tags.tag;
                    if (Array.isArray(tags)) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        lastfmTags = tags.map((t: any) => t.name);
                    } else if (typeof tags === 'object' && tags !== null) {
                        lastfmTags =[tags.name];
                    }
                }
            } catch (e) {
                console.error("Could not fetch album tags:", e);
            }
        }

        let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
            || track.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
            || track.image[track.image.length - 1]?.['#text'];

        if (!await isValidImageUrl(albumArtUrl) || albumArtUrl.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
            albumArtUrl = await findCoverArt(artist, albumName);
        }

        if (!albumArtUrl) {
            await fetch(webhookUrl, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find album art for **${trackName}** by **${artist}**.` }),
                headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }
        
        syncAlbumCover(artist, albumName, albumArtUrl, interaction.member!.user.id);

        // --- NEW: LINK GENRES ASYNC ---
        if (lastfmTags.length > 0) {
            const slug = generateSlug(artist, albumName);
            linkAlbumGenres(slug, lastfmTags, interaction.member!.user.id);
        }

        const dominantColor = await getDominantColor(albumArtUrl);
        const baseUrl = getBaseUrl();
        let iconUrl = 'https://www.last.fm/static/images/lastfm_avatar_twitter.52a5d69a85ac.png';
        if (dominantColor) {
            const hexColor = dominantColor.toString(16).padStart(6, '0');
            iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
        }
        
        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;
        const minTitleLength = 20;
        const paddingChar = '⠀';
        const paddingNeeded = Math.max(0, minTitleLength - trackName.length);
        const padding = paddingChar.repeat(paddingNeeded);
        const paddedTitle = trackName + padding;

        const embed = {
            title: paddedTitle,
            description: `${artist} •  ${albumName} \n${formattedDuration}`,
            color: dominantColor || 0xd51007,
            thumbnail: { url: albumArtUrl },
            footer: { text: footerText, icon_url: iconUrl },
                };

        const loveCustomId = encodeLoveId(discordUserId, artist, trackName);
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [embed],
                components: [{
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: ButtonStyle.Secondary,
                            label: 'Re-sync',
                            custom_id: `resync_fm_${discordUserId}`,
                        },
                        {
                            type: 2,
                            style: ButtonStyle.Secondary,
                            label: '🖤',
                            custom_id: loveCustomId,
                        },
                    ],
                }],
            }),
        });

    } catch (error) {
        console.error("Error during fm re-sync:", error);
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'An error occurred while re-syncing from Last.fm.' }),
        });
    }
    return new NextResponse(null, { status: 204 });
}

//#region Love Button Handler

export async function handleFmLove(interaction: APIMessageComponentButtonInteraction) {
    const customId = interaction.data.custom_id;
    const actingUserId = interaction.member?.user.id || interaction.user?.id;

    const withoutPrefix = customId.replace('love_fm_', '');
    const underscoreIdx = withoutPrefix.indexOf('_');
    const originalUserId = withoutPrefix.substring(0, underscoreIdx);
    const payload = withoutPrefix.substring(underscoreIdx + 1);

    if (actingUserId !== originalUserId) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "This button isn't for you!", flags: 1 << 6 },
        });
    }

    const separatorIdx = payload.indexOf('||');
    const artist = separatorIdx !== -1 ? payload.substring(0, separatorIdx) : payload;
    const trackName = separatorIdx !== -1 ? payload.substring(separatorIdx + 2) : '';

    const sessionKey = await getUserLastFMSessionKey(actingUserId);

    if (!sessionKey) {
        // No session — send DM with auth link, respond ephemerally (no message edit needed)
        const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
        const baseUrl = getBaseUrl();
        const callbackUrl = encodeURIComponent(
            `${baseUrl}/api/lastfm-callback?state=${actingUserId}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(trackName)}`
        );
        const authUrl = `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&cb=${callbackUrl}`;

        const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
        try {
            const dmChannelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                },
                body: JSON.stringify({ recipient_id: actingUserId }),
            });
            const dmChannel = await dmChannelRes.json();
            if (dmChannel.id) {
                await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                    },
                    body: JSON.stringify({
                        content: `💿 To love tracks on Last.fm, you need to connect your account once.\n\n**[Click here to authorize →](<${authUrl}>)**\n\nAfter authorizing, **${trackName}** by **${artist}** will be loved automatically and future 🖤 presses will work instantly.`,
                    }),
                });
            }
        } catch (err) {
            console.error('[DM Error]', err);
        }

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `🔐 Check your DMs! You need to connect your Last.fm account once to use this feature.`,
                flags: 1 << 6,
            },
        });
    }

    // We have a session key — defer the message update so we can edit the original
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: InteractionResponseType.DeferredMessageUpdate }),
    });

    const webhookUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

    try {
        await loveTrack(artist, trackName, sessionKey);

        // Rebuild the components from the original message, swapping 🖤 → ❤️
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalComponents = (interaction.message.components ?? []) as any[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updatedComponents = originalComponents.map((row: any) => ({
    ...row,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    components: row.components.map((component: any) => {
        if ('custom_id' in component && component.custom_id === customId) {
            return { ...component, label: '❤️' };
        }
        return component;
    }),
}));

        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ components: updatedComponents }),
        });

    } catch (err) {
        console.error('[Love Track Error]', err);
        // Send a followup ephemeral error — we can't edit the original with an error here
        // since DeferredMessageUpdate already committed us to editing the original message
        await fetch(
            `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `❌ Failed to love the track. Your session may have expired — press 🖤 again to re-authenticate.`,
                    flags: 1 << 6,
                }),
            }
        );
    }

    return new NextResponse(null, { status: 204 });
}

//#endregion