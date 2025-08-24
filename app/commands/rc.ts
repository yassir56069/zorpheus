import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';

// --- Start of re-used helper functions from cover.ts ---

/**
 * Fetches an image from a URL and returns it as a Buffer.
 * @param url The URL of the image to fetch.
 * @returns A Promise that resolves with the image Buffer.
 */
async function fetchImageBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText} for URL: ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

function normalizeString(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function isValidImageUrl(url: string | null | undefined, timeout = 2500): Promise<boolean> {
    if (!url) return false;
    if (url === 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png') return false;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        return response.ok;
    } catch (error) {
        clearTimeout(timeoutId);
        return false;
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
        const frontImage = caData.images?.find((img: { front: boolean }) => img.front);
        return frontImage?.image || null;
    } catch (error) {
        console.error("Error fetching from MusicBrainz/Cover Art Archive:", error);
        return null;
    }
}

async function findCoverArt(artist: string, album: string): Promise<string | null> {
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
        const response = await fetch(itunesUrl);
        const data = await response.json();

        if (data.resultCount > 0) {
            const bestMatch = data.results.find((r: { collectionName: string; }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];
            return bestMatch.artworkUrl100.replace('100x100', '1000x1000');
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }

    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (musicBrainzArt) return musicBrainzArt;

    return null;
}

// --- End of re-used helper functions ---

async function handleAlbumSearchRc(interaction: APIChatInputApplicationCommandInteraction, initialSearchQuery: string) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST', body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }), headers: { 'Content-Type': 'application/json' },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    let finalAlbumArtUrl: string | null = null;

    const searchQueries = [initialSearchQuery, normalizeString(initialSearchQuery)].filter((v, i, a) => a.indexOf(v) === i);

    try {
        for (const query of searchQueries) {
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(query)}&api_key=${apiKey}&format=json&limit=1`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            if (data.error || !data.results?.albummatches?.album?.[0]) continue;

            const album = data.results.albummatches.album[0];
            const artUrl = album.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'];

            if (await isValidImageUrl(artUrl)) {
                finalAlbumArtUrl = artUrl;
            } else {
                finalAlbumArtUrl = await findCoverArt(album.artist, album.name);
            }

            if (finalAlbumArtUrl) break;
        }

        if (finalAlbumArtUrl) {
            finalAlbumArtUrl = finalAlbumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");
            const imageBuffer = await fetchImageBuffer(finalAlbumArtUrl);
            
            const formData = new FormData();
            formData.append('file', new Blob([imageBuffer]), 'cover.png');
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: formData,
            });
        } else {
            const content = `Could not find album art for \`${initialSearchQuery}\`.`;
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        console.error(error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', body: JSON.stringify({ content: 'An error occurred while processing your request.' }), headers: { 'Content-Type': 'application/json' },
        });
    }
}

async function handleUserScrobbleRc(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST', body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }), headers: { 'Content-Type': 'application/json' },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` }), headers: { 'Content-Type': 'application/json' },
            });
            return;
        }
        
        const track = data.recenttracks.track[0];
        let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'];

        if (!await isValidImageUrl(albumArtUrl)) {
            albumArtUrl = await findCoverArt(track.artist['#text'], track.album['#text']);
        }

        if (!albumArtUrl) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content: `Could not find album art for **${track.name}** by **${track.artist['#text']}**.` }), headers: { 'Content-Type': 'application/json' },
            });
            return;
        }

        albumArtUrl = albumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");
        const imageBuffer = await fetchImageBuffer(albumArtUrl);

        const formData = new FormData();
        formData.append('file', new Blob([imageBuffer]), 'cover.png');

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', body: formData,
        });
    } catch (error) {
        console.error(error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', body: JSON.stringify({ content: 'An error occurred while fetching data from Last.fm.' }), headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function handleRc(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options;

    if (options && options.length > 0) {
        const searchOption = options[0] as APIApplicationCommandInteractionDataStringOption;
        if (searchOption.name === 'search') {
            await handleAlbumSearchRc(interaction, searchOption.value);
            return new NextResponse(null, { status: 204 });
        }
    }

    const discordUserId = interaction.member!.user.id;
    const lastfmUsername = await kv.get(discordUserId) as string | null;

    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `Please register your Last.fm username with \`/register\` first, or use the \`/rc search:<album name>\` option.`,
                flags: 1 << 6, // Ephemeral message
            },
        });
    }
    
    await handleUserScrobbleRc(interaction, lastfmUsername);
    return new NextResponse(null, { status: 204 });
}