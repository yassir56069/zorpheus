// app/commands/cover.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    APIApplicationCommandInteractionDataBooleanOption,
    APIMessageComponentButtonInteraction,
    ButtonStyle,
    ComponentType,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';
import { generateSlug, syncAlbumCover } from '@/utils/database/album-service';
import { getUserByDiscordId, getUserLastFM } from '@/utils/database/user-service';
import { linkAlbumGenres } from '@/utils/database/genre-service';

// --- Types ---

interface CoverSession {
    userId: string;
    artist: string;
    album: string;
    covers: CoverImage[];
    currentIndex: number;
}

interface CoverImage {
    url: string;
    source: 'iTunes' | 'MusicBrainz' | 'Last.fm';
    color: number | null;
}

// --- Helper Functions ---

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normalizeString(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function isValidImageUrl(url: string | null | undefined, timeout = 2500): Promise<boolean> {
    if (!url) return false;
    // Check for Last.fm's known placeholder
    if (url.includes('2a96cbd8b46e442fc41c2b86b821562f')) return false;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        return response.ok;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
        clearTimeout(timeoutId);
        return false;
    }
}

async function getDominantColor(imageUrl: string): Promise<number | null> {
    try {
        const palette = await Vibrant.from(imageUrl).getPalette();
        const vibrantSwatch = palette.Vibrant || palette.Muted || palette.LightVibrant;
        if (vibrantSwatch?.hex) {
            return parseInt(vibrantSwatch.hex.substring(1), 16);
        }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) { /* Silent catch */ }
    return null;
}

// --- Fetching Logic ---

async function fetchFromMusicBrainz(artist: string, album: string): Promise<CoverImage | null> {
    const userAgent = process.env.MUSICBRAINZ_USER_AGENT;
    if (!userAgent) return null;

    try {
        const musicBrainzUrl = `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(album)}%20AND%20artist:${encodeURIComponent(artist)}&fmt=json`;
        const mbResponse = await fetch(musicBrainzUrl, { headers: { 'User-Agent': userAgent } });
        if (!mbResponse.ok) return null;

        const mbData = await mbResponse.json();
        const releaseId = mbData.releases?.[0]?.id;
        if (!releaseId) return null;

        const coverArtUrl = `https://coverartarchive.org/release/${releaseId}`;
        const caResponse = await fetch(coverArtUrl);
        if (!caResponse.ok) return null;

        const caData = await caResponse.json();
        const frontImage = caData.images?.find((img: { front: boolean; }) => img.front);

        if (frontImage?.image && await isValidImageUrl(frontImage.image)) {
            const color = await getDominantColor(frontImage.image);
            return { url: frontImage.image, source: 'MusicBrainz', color };
        }
    } catch (e) { console.error("MB Error", e); }
    return null;
}

async function fetchFromITunes(artist: string, album: string): Promise<CoverImage | null> {
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=1`;
        const response = await fetch(itunesUrl);
        const data = await response.json();

        if (data.resultCount > 0) {
            const bestMatch = data.results[0];
            const highResUrl = bestMatch.artworkUrl100.replace('100x100', '1000x1000');
            if (await isValidImageUrl(highResUrl)) {
                const color = await getDominantColor(highResUrl);
                return { url: highResUrl, source: 'iTunes', color };
            }
        }
    } catch (e) { console.error("iTunes Error", e); }
    return null;
}

// Last.fm is passed in usually, but helper here for consistency
async function processLastFmUrl(url: string | null): Promise<CoverImage | null> {
    if (!url) return null;
    const highResUrl = url.replace(/\/\d+x\d+\//, "/1000x1000/");
    if (await isValidImageUrl(highResUrl)) {
        const color = await getDominantColor(highResUrl);
        return { url: highResUrl, source: 'Last.fm', color };
    }
    return null;
}

/**
 * Gathers covers from all sources concurrently.
 */
async function collectAllCovers(artist: string, album: string, lastFmUrl: string | null): Promise<CoverImage[]> {
    const promises = [
        fetchFromITunes(artist, album),
        fetchFromMusicBrainz(artist, album),
        processLastFmUrl(lastFmUrl)
    ];

    const results = await Promise.allSettled(promises);
    
    const covers: CoverImage[] = [];
    results.forEach(result => {
        if (result.status === 'fulfilled' && result.value) {
            // Avoid duplicates based on URL (simple check)
            if (!covers.some(c => c.url === result.value!.url)) {
                covers.push(result.value);
            }
        }
    });

    // Sort priority: iTunes > MusicBrainz > Last.fm
    const priority = { 'iTunes': 0, 'MusicBrainz': 1, 'Last.fm': 2 };
    covers.sort((a, b) => priority[a.source] - priority[b.source]);

    return covers;
}

const getBaseUrl = () => {
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:2999';
};

// --- Response Handling ---

function buildComponents(sessionId: string, current: number, total: number) {
    if (total <= 1) return [];

    return [{
        type: ComponentType.ActionRow,
        components: [
            {
                type: ComponentType.Button,
                custom_id: `cov_prev_${sessionId}`,
                style: ButtonStyle.Secondary,
                label: '◀',
                disabled: current === 0
            },
            {
                type: ComponentType.Button,
                custom_id: `cov_stat_${sessionId}`,
                style: ButtonStyle.Secondary,
                label: `${current + 1} / ${total}`,
                disabled: true
            },
            {
                type: ComponentType.Button,
                custom_id: `cov_next_${sessionId}`,
                style: ButtonStyle.Secondary,
                label: '▶',
                disabled: current === total - 1
            }
        ]
    }];
}

async function sendFinalResponse(
    appId: string,
    token: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedData: any, 
    coverImage: CoverImage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    components: any[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isUpdate = false
) {
    try {
        const imageResponse = await fetch(coverImage.url);
        
        if (!imageResponse.ok) {
            console.error(`Failed to download image from ${coverImage.url}`);
            // Fallback: Embed only
            await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ embeds: [embedData], components: [] }),
                headers: { 'Content-Type': 'application/json' },
            });
            return;
        }

        const imageBuffer = await imageResponse.arrayBuffer();
        const formData = new FormData();

        // Update footer to include Source
        embedData.footer = {
            ...embedData.footer,
            text: `${embedData.footer.text} • Source: ${coverImage.source}`
        };

        const payload = {
            embeds: [embedData],
            components: components,
            attachments: [{ id: 0, filename: 'cover.png' }] // Distinct attachment reference
        };

        formData.append('payload_json', JSON.stringify(payload));
        formData.append('files[0]', new Blob([imageBuffer]), 'cover.png');

        const response = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
            method: 'PATCH',
            body: formData,
        });

        if (!response.ok) {
            console.error(`Discord API Error: ${response.status}`);
        }

    } catch (error) {
        console.error("Error sending combined response:", error);
    }
}


// --- Main Handlers ---

async function processCoverRequest(
    interaction: APIChatInputApplicationCommandInteraction,
    artist: string,
    albumName: string,
    rawLastFmUrl: string | null,
    footerText: string
) {
    // 1. Gather all covers
    const covers = await collectAllCovers(artist, albumName, rawLastFmUrl);

    if (covers.length === 0) {
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: `Could not find album art for **${albumName}** by **${artist}**.` }),
            headers: { 'Content-Type': 'application/json' },
        });
        return;
    }

    const bestCover = covers[0].url;
    const userId = interaction.member!.user.id;

    // We don't await this to keep the bot response snappy (fire and forget)
    if (userId !== '508817156847173632') { 
        syncAlbumCover(artist, albumName, bestCover, userId);
        
        // --- NEW: LINK GENRES ASYNC ---
        // We fetch the tags here asynchronously so we don't hold up the discord reply
        fetchAlbumTags(artist, albumName).then(lastfmTags => {
            if (lastfmTags.length > 0) {
                const slug = generateSlug(artist, albumName);
                linkAlbumGenres(slug, lastfmTags, userId);
            }
        }).catch(err => console.error("Genre linking error:", err));
    }

    // 2. Prepare Session Data
    const sessionId = interaction.id; // Use interaction ID as unique session key
    const sessionData: CoverSession = {
        userId: interaction.member!.user.id,
        artist,
        album: albumName,
        covers,
        currentIndex: 0
    };

    // 3. Store in KV (Expires in 5 mins to save hobby tier limits)
    await kv.set(`cov_sess:${sessionId}`, sessionData, { ex: 300 });

    // 4. Construct Initial Response
    const currentCover = covers[0];
    const hexColor = (currentCover.color || 0xd51007).toString(16).padStart(6, '0');
    const iconUrl = `${getBaseUrl()}/api/recolor-icon?color=${hexColor}`;

    const embed = {
        title: albumName,
        description: `-# by **${artist}**`,
        color: currentCover.color || 0xd51007,
        footer: { text: footerText, icon_url: iconUrl }
    };

    const components = buildComponents(sessionId, 0, covers.length);

    await sendFinalResponse(
        interaction.application_id,
        interaction.token,
        embed,
        currentCover,
        components
    );
}

// --- Handler Entry Points ---

async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, initialSearchQuery: string) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(initialSearchQuery)}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();
        const albumData = data.results?.albummatches?.album?.[0];

        if (!albumData) {
             await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find album \`${initialSearchQuery}\`.` }),
                headers: { 'Content-Type': 'application/json' },
            });
            return;
        }

        const artist = albumData.artist;
        const albumName = albumData.name;
        // Get largest available image
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lastFmUrl = albumData.image.find((img: any) => img.size === 'extralarge')?.['#text'] || albumData.image.at(-1)?.['#text'];

        await processCoverRequest(
            interaction, 
            artist, 
            albumName, 
            lastFmUrl, 
            `Searched by: ${interaction.member!.user.username}`
        );

    } catch (error) {
        console.error(error);
        // Error handling...
    }
}

async function handleUserScrobble(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });
    
    // ... existing options parsing ...
    const options = interaction.data.options ?? [];
    const youtubeScrobbleOption = options.find(opt => opt.name === 'youtube_scrobble') as APIApplicationCommandInteractionDataBooleanOption | undefined;
    const applyYoutubeScrobbleFix = youtubeScrobbleOption?.value === false ? false : true;

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks?.track.length) {
            // ... error handling
            return;
        }
        
        const track = data.recenttracks.track[0];
        let artist = track.artist['#text'];
        const albumName = track.album['#text'];

        if (applyYoutubeScrobbleFix && artist.endsWith(' - Topic')) {
            artist = artist.replace(' - Topic', '').trim();
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lastFmUrl = track.image.find((img: any) => img.size === 'extralarge')?.['#text'] || track.image.at(-1)?.['#text'];
        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;

        await processCoverRequest(
            interaction, 
            artist, 
            albumName, 
            lastFmUrl, 
            footerText
        );

    } catch (error) {
        console.error(error);
    }
}

// --- NEW: Button Interaction Handler ---

export async function handleCoverButtonInteraction(interaction: APIMessageComponentButtonInteraction) {
    const customId = interaction.data.custom_id;
    // Format: cov_<action>_<sessionId>
    const [, action, sessionId] = customId.split('_');

    // 1. Acknowledge immediately (Update Message)
    // We defer update so the user doesn't see "Interaction Failed" while we download the image
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredMessageUpdate }),
        headers: { 'Content-Type': 'application/json' },
    });

    // 2. Retrieve Session
    const sessionKey = `cov_sess:${sessionId}`;
    const session = await kv.get<CoverSession>(sessionKey);

    if (!session) {
        // Session expired
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ components: [] }), // Remove buttons
            headers: { 'Content-Type': 'application/json' },
        });
        return new NextResponse(null, { status: 200 });
    }

    // 3. Authorization Check
    if (interaction.member!.user.id !== session.userId) {
        // We can't reply ephemerally to a DeferredMessageUpdate easily in a way that doesn't edit the message.
        // Usually, you would do a separate POST to send an ephemeral error, 
        // but for simplicity here we just ignore the click or log it.
        return new NextResponse(null, { status: 200 });
    }

    // 4. Update Logic
    let newIndex = session.currentIndex;
    if (action === 'prev') newIndex = Math.max(0, newIndex - 1);
    if (action === 'next') newIndex = Math.min(session.covers.length - 1, newIndex + 1);

    if (newIndex === session.currentIndex) return new NextResponse(null, { status: 200 }); // No change

    // 5. Update State
    session.currentIndex = newIndex;
    await kv.set(sessionKey, session, { ex: 300 }); // Refresh TTL

    // 6. Fetch New Image and Send Update
    const currentCover = session.covers[newIndex];
    const hexColor = (currentCover.color || 0xd51007).toString(16).padStart(6, '0');
    const iconUrl = `${getBaseUrl()}/api/recolor-icon?color=${hexColor}`;

    // Reconstruct Embed (We need to preserve the footer text but change the icon)
    // To do this perfectly, we'd ideally store the footer text in KV, but let's reconstruct it or grab it from the interaction message if possible.
    // Since we don't have the footer text in KV, we can check interaction.message
    const originalEmbed = interaction.message.embeds[0];
    const originalFooterText = originalEmbed.footer?.text?.split(' • Source:')[0] || `Album: ${session.album}`;

    const embed = {
        title: session.album,
        description: `-# by **${session.artist}**`,
        color: currentCover.color || 0xd51007,
        footer: { text: originalFooterText, icon_url: iconUrl }
    };

    const components = buildComponents(sessionId, newIndex, session.covers.length);

    await sendFinalResponse(
        interaction.application_id,
        interaction.token,
        embed,
        currentCover,
        components,
        true
    );

    return new NextResponse(null, { status: 200 });
}

export async function handleCover(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];
    const searchOption = options.find(opt => opt.name === 'search') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (searchOption) {
        await handleAlbumSearch(interaction, searchOption.value);
    } else {
        const discordUserId = interaction.member!.user.id;
        const lastfmUsername = await getUserLastFM(discordUserId);

        if (!lastfmUsername) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: {
                    content: `You must register first.`,
                    flags: 1 << 6, 
                },
            });
        }
        await handleUserScrobble(interaction, lastfmUsername);
    }
    
    return new NextResponse(null, { status: 204 });
}

async function fetchAlbumTags(artist: string, album: string): Promise<string[]> {
    const apiKey = process.env.LASTFM_API_KEY;
    if (!apiKey) return[];
    
    try {
        const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&format=json`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.album?.tags?.tag) {
            const tags = Array.isArray(data.album.tags.tag) ? data.album.tags.tag : [data.album.tags.tag];
            return tags.map((t: { name: string }) => t.name);
        }
    } catch (e) {
        console.error("Error fetching Last.fm tags:", e);
    }
    
    return[];
}
