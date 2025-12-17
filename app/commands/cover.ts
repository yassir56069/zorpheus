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
    APIActionRowComponent,
    APIButtonComponent
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';

// --- Interfaces ---

interface CoverCandidate {
    source: string; // e.g., "Last.fm", "iTunes", "MusicBrainz"
    url: string;
}

// --- Helper Functions ---

function normalizeString(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function isValidImageUrl(url: string | null | undefined, timeout = 2500): Promise<boolean> {
    if (!url) return false;
    // Check for Last.fm's known placeholder
    if (url.includes('2a96cbd8b46e442fc41c2b86b821562f.png')) return false;

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
    } catch (error) {
        // Silent catch
    }
    return null;
}

// --- Sources Fetching ---

async function fetchMusicBrainzCover(artist: string, album: string): Promise<string | null> {
    const userAgent = process.env.MUSICBRAINZ_USER_AGENT || 'DiscordBot/1.0 ( your@email.com )';
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
        return frontImage?.image || null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
        return null;
    }
}

async function fetchItunesCover(artist: string, album: string): Promise<string | null> {
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=1`;
        const response = await fetch(itunesUrl);
        const data = await response.json();

        if (data.resultCount > 0) {
            const result = data.results[0];
            return result.artworkUrl100.replace('100x100', '1000x1000');
        }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
        return null;
    }
    return null;
}

async function findAllCovers(artist: string, album: string, primaryUrl: string | null): Promise<CoverCandidate[]> {
    const candidates: CoverCandidate[] = [];

    // 1. Last.fm (Primary)
    if (await isValidImageUrl(primaryUrl)) {
        candidates.push({ source: 'Last.fm', url: primaryUrl! });
    }

    // 2. iTunes & MusicBrainz (Parallel fetch)
    const [itunesUrl, mbUrl] = await Promise.all([
        fetchItunesCover(artist, album),
        fetchMusicBrainzCover(artist, album)
    ]);

    if (await isValidImageUrl(itunesUrl)) {
        candidates.push({ source: 'iTunes', url: itunesUrl! });
    }

    if (await isValidImageUrl(mbUrl)) {
        candidates.push({ source: 'MusicBrainz', url: mbUrl! });
    }

    const uniqueCandidates: CoverCandidate[] = [];
    const seenUrls = new Set<string>();
    
    for (const c of candidates) {
        if (!seenUrls.has(c.url)) {
            seenUrls.add(c.url);
            uniqueCandidates.push(c);
        }
    }

    return uniqueCandidates;
}

const getBaseUrl = () => {
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:2999';
};

// --- Sending Logic ---

function encodeStateInDescription(description: string | undefined, covers: CoverCandidate[]): string {
    const existingDesc = description || '';
    const hiddenLinks = covers.map(c => `[\u200b](${c.url})`).join(' ');
    return `${existingDesc}\n${hiddenLinks}`;
}

function decodeStateFromDescription(description: string): string[] {
    const regex = /\[\u200b\]\((https?:\/\/[^)]+)\)/g;
    const matches = [...description.matchAll(regex)];
    return matches.map(m => m[1]);
}

async function sendCoverResponse(
    interaction: APIChatInputApplicationCommandInteraction | APIMessageComponentButtonInteraction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseEmbed: any,
    covers: CoverCandidate[],
    selectedIndex: number,
    isUpdate = false 
) {
    if (covers.length === 0) return;

    const selectedCover = covers[selectedIndex];
    
    let imageBuffer: ArrayBuffer | null = null;
    let dominantColor: number | null = null;

    try {
        const processUrl = selectedCover.url.replace(/\/\d+x\d+\//, "/1000x1000/");
        const res = await fetch(processUrl);
        if (res.ok) {
            imageBuffer = await res.arrayBuffer();
            dominantColor = await getDominantColor(processUrl);
        }
    } catch (e) {
        console.error("Failed to process image", e);
    }

    const finalColor = dominantColor || baseEmbed.color || 0xd51007;
    const hexColor = finalColor.toString(16).padStart(6, '0');
    const baseUrl = getBaseUrl();
    const iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;

    const footer = { 
        text: baseEmbed.footer?.text || '', 
        icon_url: iconUrl 
    };

    let cleanDescription = baseEmbed.description || "";
    cleanDescription = cleanDescription.replace(/\[\u200b\]\((.*?)\)/g, '').trim();
    
    const descriptionWithState = encodeStateInDescription(cleanDescription, covers);

    const finalEmbed = {
        ...baseEmbed,
        color: finalColor,
        description: descriptionWithState,
        footer,
        image: { url: 'attachment://cover.png' } 
    };

    // Safely get user ID
    const userId = (interaction.member?.user ?? interaction.user!).id;

    // Construct Components (Buttons)
    const components = [];
    if (covers.length > 1) {
        const buttonComponents = covers.map((cover, index) => ({
            type: ComponentType.Button,
            style: selectedIndex === index ? ButtonStyle.Success : ButtonStyle.Secondary,
            label: cover.source,
            custom_id: `cover_select_${index}_${userId}`,
            disabled: selectedIndex === index
        }));

        // Limit to 5 buttons per row (Discord limit)
        const row = {
            type: ComponentType.ActionRow,
            components: buttonComponents.slice(0, 5)
        };
        components.push(row);
    }

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({
        embeds: [finalEmbed],
        components: components,
    }));

    if (imageBuffer) {
        formData.append('files[0]', new Blob([imageBuffer]), 'cover.png');
    }

    let endpoint = '';
    let method = 'POST';

    if (isUpdate) {
        // [FIX 1] Changed DeferredUpdateMessage to DeferredMessageUpdate
        endpoint = `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`;
        await fetch(endpoint, {
            method: 'POST',
            body: JSON.stringify({ type: InteractionResponseType.DeferredMessageUpdate }),
            headers: { 'Content-Type': 'application/json' }
        });

        const msgInteraction = interaction as APIMessageComponentButtonInteraction;
        endpoint = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/${msgInteraction.message.id}`;
        method = 'PATCH';
    } else {
        endpoint = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
        method = 'PATCH';
    }

    const response = await fetch(endpoint, {
        method: method,
        body: formData,
    });

    if (!response.ok) {
        console.error("Error sending Discord response", await response.text());
    }
}

// --- Interaction Handlers ---

export async function handleCoverSelection(interaction: APIMessageComponentButtonInteraction) {
    const customId = interaction.data.custom_id;
    const parts = customId.split('_');
    const targetIndex = parseInt(parts[2]);
    const originalUserId = parts[3];

    if ((interaction.member?.user ?? interaction.user!).id !== originalUserId) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "These buttons are for the user who ran the command.",
                flags: 1 << 6
            }
        });
    }

    const message = interaction.message;
    const embed = message.embeds[0];
    if (!embed || !embed.description) {
        return new NextResponse("Embed data missing", { status: 400 });
    }

    const urlList = decodeStateFromDescription(embed.description);
    
    // --- FIX: Use APIButtonComponent in the generic ---
    const actionRow = message.components?.[0] as APIActionRowComponent<APIButtonComponent> | undefined;
    const buttons = actionRow?.components; 
    
    if (!urlList.length || !buttons) {
        return new NextResponse("State lost", { status: 400 });
    }

    const covers: CoverCandidate[] = urlList.map((url, idx) => {
        const button = buttons[idx];
        
        // Cast to 'any' to safely access 'label'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const label = (button as any)?.label ?? "Image";
        
        return {
            url: url,
            source: label
        };
    });

    if (!covers[targetIndex]) {
        return new NextResponse("Image not found", { status: 404 });
    }

    await sendCoverResponse(interaction, embed, covers, targetIndex, true);
    return new NextResponse(null, { status: 200 });
}

async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, initialSearchQuery: string) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const searchQueries = [initialSearchQuery];
    const normalizedQuery = normalizeString(initialSearchQuery);
    if (normalizedQuery !== initialSearchQuery) searchQueries.push(normalizedQuery);

    try {
        let covers: CoverCandidate[] = [];
        let finalArtist: string | null = null;
        let finalAlbumName: string | null = null;

        for (const query of searchQueries) {
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(query)}&api_key=${apiKey}&format=json&limit=1`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            const albumData = data.results?.albummatches?.album?.[0];
            if (!albumData) continue;

            finalArtist = albumData.artist;
            finalAlbumName = albumData.name;
            const primaryUrl = albumData.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || albumData.image.at(-1)?.['#text'];

            covers = await findAllCovers(finalArtist!, finalAlbumName!, primaryUrl);

            if (covers.length > 0) break; 
        }

        if (covers.length > 0 && finalArtist && finalAlbumName) {
            const embed = {
                title: finalAlbumName,
                description: `-# by **${finalArtist}**`,
                footer: {
                    text: `Searched by: ${interaction.member!.user.username}`,
                }
            };
            await sendCoverResponse(interaction, embed, covers, 0, false);
        } else {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find album art for \`${initialSearchQuery}\`.` }),
                headers: { 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        console.error(error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: `An error occurred while searching.` }),
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

async function handleUserScrobble(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });
    
    const options = interaction.data.options ?? [];
    const youtubeScrobbleOption = options.find(opt => opt.name === 'youtube_scrobble') as APIApplicationCommandInteractionDataBooleanOption | undefined;
    const applyYoutubeScrobbleFix = youtubeScrobbleOption?.value !== false;

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks?.track.length) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` }),
                headers: { 'Content-Type': 'application/json' },
            });
            return;
        }
        
        const track = data.recenttracks.track[0];
        let artist = track.artist['#text'];
        const albumName = track.album['#text'];

        if (applyYoutubeScrobbleFix && artist.endsWith(' - Topic')) {
            artist = artist.replace(' - Topic', '').trim();
        }

        const primaryUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image.at(-1)?.['#text'];

        const covers = await findAllCovers(artist, albumName, primaryUrl);

        if (covers.length === 0) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find album art for **${track.name}** by **${artist}**.` }),
                headers: { 'Content-Type': 'application/json' },
            });
            return;
        }

        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;

        const embed = {
            title: albumName || track.name,
            description: `-# by **${artist}**`,
            footer: { text: footerText }
        };

        await sendCoverResponse(interaction, embed, covers, 0, false);

    } catch (error) {
        console.error(error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: `An error occurred while fetching data from Last.fm.` }),
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function handleCover(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];
    const searchOption = options.find(opt => opt.name === 'search') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (searchOption) {
        await handleAlbumSearch(interaction, searchOption.value);
    } else {
        const discordUserId = interaction.member!.user.id;
        const lastfmUsername = await kv.get(discordUserId) as string | null;

        if (!lastfmUsername) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: {
                    content: `You must register your Last.fm username with \`/register\` first.`,
                    flags: 1 << 6, 
                },
            });
        }
        await handleUserScrobble(interaction, lastfmUsername);
    }
    
    return new NextResponse(null, { status: 204 });
}