import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    APIApplicationCommandInteractionDataBooleanOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';

// --- Helper Functions ---

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
    if (url === 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png') {
        console.log('LastFM returned a placeholder image.');
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
        return false;
    }
}

async function findCoverOnItunes(artist: string, album: string): Promise<string | null> {
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
        const response = await fetch(itunesUrl);
        const data = await response.json();
        if (data.resultCount > 0) {
            const bestMatch = data.results.find((r: { collectionName: string; }) => normalizeString(r.collectionName).toLowerCase() === normalizeString(album).toLowerCase()) || data.results[0];
            return bestMatch.artworkUrl100.replace('100x100', '1000x1000');
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }
    return null;
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
        const caResponse = await fetch(coverArtUrl, { headers: { 'Accept': 'application/json' } });
        if (!caResponse.ok) return null;
        const caData = await caResponse.json();
        const frontImage = caData.images?.find((img: { front: boolean }) => img.front);
        return frontImage?.image || null;
    } catch (error) {
        console.error("Error fetching from MusicBrainz/Cover Art Archive:", error);
        return null;
    }
}

async function findCoverArtSequentially(artist: string, album: string): Promise<string | null> {
    const itunesArt = await findCoverOnItunes(artist, album);
    if (await isValidImageUrl(itunesArt)) return itunesArt;
    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (await isValidImageUrl(musicBrainzArt)) return musicBrainzArt;
    return null;
}

async function findAllCoverArtSources(artist: string, album: string, lastfmUrl: string | null): Promise<(string | null)[]> {
    const sourcePromises = [
        Promise.resolve(lastfmUrl),
        findCoverOnItunes(artist, album),
        findCoverOnMusicBrainz(artist, album),
    ];
    const results = await Promise.all(sourcePromises);
    return results.filter(url => url);
}

function getImageQualityScore(url: string | null): number {
    if (!url) return 0;
    if (url.includes('coverartarchive.org')) return 5000;
    const match = url.match(/(\d+)x\d+/);
    if (match && match[1]) return parseInt(match[1], 10);
    if (url.includes('/i/u/')) {
        if (url.includes('300x300')) return 300;
        if (url.includes('174s')) return 174;
    }
    return 100;
}

async function getBestImageUrl(urls: (string | null)[]): Promise<string | null> {
    const validUrls = [];
    for (const url of urls) {
        if (await isValidImageUrl(url)) {
            validUrls.push(url!);
        }
    }
    if (validUrls.length === 0) return null;
    validUrls.sort((a, b) => getImageQualityScore(b) - getImageQualityScore(a));
    return validUrls[0];
}

// --- Command Handlers ---

async function handleAlbumSearchRc(interaction: APIChatInputApplicationCommandInteraction, initialSearchQuery: string, hqOnly: boolean) {
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
            const artist = album.artist;
            const albumName = album.name;
            const lastfmAlbumArtUrl = album.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'];

            if (hqOnly) {
                const allUrls = await findAllCoverArtSources(artist, albumName, lastfmAlbumArtUrl);
                finalAlbumArtUrl = await getBestImageUrl(allUrls);
            } else {
                if (await isValidImageUrl(lastfmAlbumArtUrl)) {
                    finalAlbumArtUrl = lastfmAlbumArtUrl;
                } else {
                    finalAlbumArtUrl = await findCoverArtSequentially(artist, albumName);
                }
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

async function handleUserScrobbleRc(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string, hqOnly: boolean) {
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
        const artist = track.artist['#text'];
        const albumName = track.album['#text'];
        const lastfmAlbumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'];
        let finalAlbumArtUrl: string | null = null;

        if (hqOnly) {
            const allUrls = await findAllCoverArtSources(artist, albumName, lastfmAlbumArtUrl);
            finalAlbumArtUrl = await getBestImageUrl(allUrls);
        } else {
            if (await isValidImageUrl(lastfmAlbumArtUrl)) {
                finalAlbumArtUrl = lastfmAlbumArtUrl;
            } else {
                finalAlbumArtUrl = await findCoverArtSequentially(artist, albumName);
            }
        }

        if (!finalAlbumArtUrl) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content: `Could not find album art for **${track.name}** by **${artist}**.` }), headers: { 'Content-Type': 'application/json' },
            });
            return;
        }

        finalAlbumArtUrl = finalAlbumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");
        const imageBuffer = await fetchImageBuffer(finalAlbumArtUrl);
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
    const options = interaction.data.options as (APIApplicationCommandInteractionDataStringOption | APIApplicationCommandInteractionDataBooleanOption)[] | undefined;
    
    const searchOption = options?.find(opt => opt.name === 'search') as APIApplicationCommandInteractionDataStringOption | undefined;
    const hqOnlyOption = options?.find(opt => opt.name === 'hq_only') as APIApplicationCommandInteractionDataBooleanOption | undefined;
    const hqOnly = hqOnlyOption?.value ?? false;

    if (searchOption?.value) {
        await handleAlbumSearchRc(interaction, searchOption.value, hqOnly);
        return new NextResponse(null, { status: 204 });
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
    
    await handleUserScrobbleRc(interaction, lastfmUsername, hqOnly);
    return new NextResponse(null, { status: 204 });
}