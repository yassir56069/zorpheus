// app/commands/cover.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    APIApplicationCommandInteractionDataBooleanOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';

// --- Helper Functions ---

function normalizeString(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function isValidImageUrl(url: string | null | undefined, timeout = 2500): Promise<boolean> {
    if (!url) return false;

    // Check for Last.fm's known placeholder image
    if (url === 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png') {
        return false;
    }

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

async function getReliableImageUrlAndColor(url: string | null | undefined): Promise<{ url: string, color: number | null } | null> {
    if (!url) return null;
    if (!await isValidImageUrl(url)) return null;

    try {
        const dominantColor = await getDominantColor(url);
        return { url, color: dominantColor };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
        return null;
    }
}

async function findCoverOnMusicBrainz(artist: string, album: string): Promise<string | null> {
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

        return frontImage?.image || null;
    } catch (error) {
        console.error("Error fetching from MusicBrainz/Cover Art Archive:", error);
        return null;
    }
}

async function findValidatedFallbackCover(artist: string, album: string): Promise<string | null> {
    // 1. Try iTunes
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
        const response = await fetch(itunesUrl);
        const data = await response.json();

        if (data.resultCount > 0) {
            const bestMatch = data.results.find((r: { collectionName: string; }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];
            const highResUrl = bestMatch.artworkUrl100.replace('100x100', '1000x1000');
            
            if (await isValidImageUrl(highResUrl)) {
                return highResUrl;
            }
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }

    // 2. Try MusicBrainz
    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (musicBrainzArt && await isValidImageUrl(musicBrainzArt)) {
        return musicBrainzArt;
    }

    return null;
}

async function getVerifiedAlbumArtUrl(primaryUrl: string | null | undefined, artist: string, album: string): Promise<{ url: string, color: number | null } | null> {
    const primaryResult = await getReliableImageUrlAndColor(primaryUrl);
    if (primaryResult) return primaryResult;
    
    const fallbackUrl = await findValidatedFallbackCover(artist, album);
    if (fallbackUrl) {
        return await getReliableImageUrlAndColor(fallbackUrl);
    }
    
    return null;
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

const getBaseUrl = () => {
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:2999';
};

/**
 * Sends the final response by splitting the image and the embed into two separate requests.
 * 1. Updates the original message with just the image file.
 * 2. Sends a follow-up message with the embed info.
 */
async function sendFinalResponse(
    interaction: APIChatInputApplicationCommandInteraction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedData: any, 
    finalAlbumArtUrl: string
) {
    try {
        // --- Step 1: Download the image ---
        const imageResponse = await fetch(finalAlbumArtUrl);
        if (!imageResponse.ok) throw new Error("Failed to fetch image");
        const imageBuffer = await imageResponse.arrayBuffer();

        // --- Step 2: Send Image (PATCH @original) ---
        // This mirrors your working 'rc' command: Just a clean file upload.
        const formData = new FormData();
        formData.append('file', new Blob([imageBuffer]), 'cover.png');

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: formData,
        });

        // --- Step 3: Send Embed (POST Follow-up) ---
        // We send a NEW message (POST) to the webhook root, not editing the original.
        // This places the embed nicely below the image.
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
            method: 'POST',
            body: JSON.stringify({ embeds: [embedData] }),
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error("Error sending split response:", error);
        // Fallback: If image upload fails, just send the embed to the original message so the bot doesn't hang.
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ embeds: [embedData] }),
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendFinalResponseText(interaction: APIChatInputApplicationCommandInteraction, content: any) {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
        method: 'PATCH',
        body: JSON.stringify(content),
        headers: { 'Content-Type': 'application/json' },
    });
}

// --- Main Handlers ---

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
        let finalAlbumArtUrl: string | null = null;
        let finalArtist: string | null = null;
        let finalAlbumName: string | null = null;
        let dominantColor = null;

        for (const query of searchQueries) {
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(query)}&api_key=${apiKey}&format=json&limit=1`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            const albumData = data.results?.albummatches?.album?.[0];
            if (!albumData) continue;

            const artist = albumData.artist;
            const albumName = albumData.name;
            const primaryUrl = albumData.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || albumData.image[albumData.image.length - 1]?.['#text'];

            const verifiedUrl = await getVerifiedAlbumArtUrl(primaryUrl, artist, albumName);

            if (verifiedUrl) {
                finalAlbumArtUrl = verifiedUrl.url;
                finalArtist = artist;
                finalAlbumName = albumName;
                dominantColor = verifiedUrl.color;
                break;
            }
        }

        if (finalAlbumArtUrl && finalArtist && finalAlbumName) {
            const baseUrl = getBaseUrl();
            const highResUrl = finalAlbumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");
            const hexColor = (dominantColor || 0xd51007).toString(16).padStart(6, '0');
            const iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
            
            const embed = {
                title: finalAlbumName,
                description: `-# by **${finalArtist}**`,
                color: dominantColor || 0xd51007,
                footer: {
                    text: `Searched by: ${interaction.member!.user.username}`,
                    icon_url: iconUrl
                }
            };
            await sendFinalResponse(interaction, embed, highResUrl);
        } else {
            let content = `Could not find album art for \`${initialSearchQuery}\`.`;
            if (searchQueries.length > 1) content += ` (also tried \`${normalizedQuery}\`).`;
            await sendFinalResponseText(interaction, { content });
        }
    } catch (error) {
        console.error(error);
        await sendFinalResponseText(interaction, { content: 'An error occurred while processing your request.' });
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
    const applyYoutubeScrobbleFix = youtubeScrobbleOption?.value === false ? false : true;

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks?.track.length) {
            await sendFinalResponseText(interaction, { content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` });
            return;
        }
        
        const track = data.recenttracks.track[0];
        let artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];

        if (applyYoutubeScrobbleFix && artist.endsWith(' - Topic')) {
            artist = artist.replace(' - Topic', '').trim();
        }

        const primaryUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]?.['#text'];

        const verifiedResult = await getVerifiedAlbumArtUrl(primaryUrl, artist, albumName);

        if (!verifiedResult) {
            await sendFinalResponseText(interaction, { content: `Could not find album art for **${trackName}** by **${artist}**.` });
            return;
        }

        const albumArtUrl = verifiedResult.url;
        const dominantColor = verifiedResult.color; 
        const highResUrl = albumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");

        const baseUrl = getBaseUrl();
        const hexColor = (dominantColor || 0xd51007).toString(16).padStart(6, '0');
        const iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
        
        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;

        const embed = {
            title: albumName,
            description: `-# by **${artist}**`,
            color: dominantColor || 0xd51007,
            footer: { text: footerText, icon_url: iconUrl }
        };

        await sendFinalResponse(interaction, embed, highResUrl);
    } catch (error) {
        console.error(error);
        await sendFinalResponseText(interaction, { content: 'An error occurred while fetching data from Last.fm.' });
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
                    content: `You must register your Last.fm username with \`/register\` first. Or, use \`/cover search:<album name>\` to find an album.`,
                    flags: 1 << 6, 
                },
            });
        }
        await handleUserScrobble(interaction, lastfmUsername);
    }
    
    return new NextResponse(null, { status: 204 });
}