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

/**
 * Converts a string to its base ASCII equivalent.
 * e.g., "Déjà Vu" -> "Deja Vu"
 * @param str The string to normalize.
 * @returns The normalized string.
 */
function normalizeString(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Checks if an image URL is valid and responsive within a given timeout.
 * @param url The URL of the image to check.
 * @param timeout The timeout in milliseconds.
 * @returns True if the image is valid and responds in time, false otherwise.
 */
async function isValidImageUrl(url: string | null | undefined, timeout = 2500): Promise<boolean> {
    if (!url) {
        return false;
    }

    // Check for Last.fm's known placeholder image
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

        if (!mbResponse.ok) {
            console.error(`MusicBrainz API returned status: ${mbResponse.status}`);
            return null;
        }

        const mbData = await mbResponse.json();
        const release = mbData.releases?.[0];
        const releaseId = release?.id;

        if (!releaseId) {
            console.log(`No release ID found on MusicBrainz for ${artist} - ${album}`);
            return null;
        }

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

/**
 * NEW: A more robust function that finds a cover from fallbacks AND validates it.
 * This ensures we only return a URL that is confirmed to be working.
 * @param artist The artist name.
 * @param album The album name.
 * @returns A validated image URL or null.
 */
async function findValidatedFallbackCover(artist: string, album: string): Promise<string | null> {
    console.log(`Searching fallbacks for "${album}" by "${artist}"`);

    // --- Fallback 1: iTunes API ---
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
        const response = await fetch(itunesUrl);
        const data = await response.json();

        if (data.resultCount > 0) {
            const bestMatch = data.results.find((r: { collectionName: string; }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];
            const highResUrl = bestMatch.artworkUrl100.replace('100x100', '1000x1000');
            
            // Key Improvement: Validate the URL before returning it
            if (await isValidImageUrl(highResUrl)) {
                console.log(`Successfully found and validated album art from iTunes: ${highResUrl}`);
                return highResUrl;
            }
            console.log(`iTunes URL found but failed validation: ${highResUrl}`);
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }

    // --- Fallback 2: MusicBrainz / Cover Art Archive ---
    console.log("iTunes failed or its URL was invalid, trying MusicBrainz...");
    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (musicBrainzArt) {
        // Key Improvement: Validate the MusicBrainz URL as well
        if (await isValidImageUrl(musicBrainzArt)) {
            console.log(`Successfully found and validated album art from MusicBrainz: ${musicBrainzArt}`);
            return musicBrainzArt;
        }
        console.log(`MusicBrainz URL found but failed validation: ${musicBrainzArt}`);
    }

    console.log(`All fallbacks failed for "${album}" by "${artist}".`);
    return null;
}


/**
 * NEW: Centralized logic to get a verified album art URL.
 * It tries the primary URL first, and if that fails, it checks all fallbacks.
 * @param primaryUrl The initial URL from Last.fm.
 * @param artist The artist name for fallbacks.
 * @param album The album name for fallbacks.
 * @returns A promise that resolves to a verified URL or null.
 */
async function getVerifiedAlbumArtUrl(primaryUrl: string | null | undefined, artist: string, album: string): Promise<string | null> {
    // Step 1: Check if the primary URL from Last.fm is valid.
    if (await isValidImageUrl(primaryUrl)) {
        console.log("Primary Last.fm URL is valid.");
        return primaryUrl!;
    }

    // Step 2: If not, try all validated fallback sources.
    console.log("Primary URL is invalid or a placeholder. Trying fallbacks...");
    return await findValidatedFallbackCover(artist, album);
}


async function getDominantColor(imageUrl: string): Promise<number | null> {
    try {
        const palette = await Vibrant.from(imageUrl).getPalette();
        const vibrantSwatch = palette.Vibrant || palette.Muted || palette.LightVibrant;
        if (vibrantSwatch?.hex) {
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

// This function sends the final message to Discord.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendFinalResponse(interaction: APIChatInputApplicationCommandInteraction, content: any) {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
        method: 'PATCH',
        body: JSON.stringify(content),
        headers: { 'Content-Type': 'application/json' },
    });
}

async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, initialSearchQuery: string) {
    // Defer the reply immediately. This is correct.
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const searchQueries = [initialSearchQuery];
    const normalizedQuery = normalizeString(initialSearchQuery);
    if (normalizedQuery !== initialSearchQuery) {
        searchQueries.push(normalizedQuery);
    }

    try {
        let finalAlbumArtUrl: string | null = null;
        let finalArtist: string | null = null;
        let finalAlbumName: string | null = null;

        for (const query of searchQueries) {
            console.log(`--- Searching for: "${query}" ---`);
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(query)}&api_key=${apiKey}&format=json&limit=1`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            const albumData = data.results?.albummatches?.album?.[0];
            if (!albumData) {
                console.log(`Last.fm found no results for "${query}".`);
                continue;
            }

            const artist = albumData.artist;
            const albumName = albumData.name;
            const primaryUrl = albumData.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || albumData.image[albumData.image.length - 1]?.['#text'];

            // Use the new centralized function to get a verified cover.
            const verifiedUrl = await getVerifiedAlbumArtUrl(primaryUrl, artist, albumName);

            if (verifiedUrl) {
                finalAlbumArtUrl = verifiedUrl;
                finalArtist = artist;
                finalAlbumName = albumName;
                break; // Found a valid cover, no need to try other queries.
            }
        }

        if (finalAlbumArtUrl && finalArtist && finalAlbumName) {
            const dominantColor = await getDominantColor(finalAlbumArtUrl);
            const baseUrl = getBaseUrl();
            const hexColor = (dominantColor || 0xd51007).toString(16).padStart(6, '0');
            const iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
            
            const embed = {
                title: finalAlbumName,
                description: `-# by **${finalArtist}**`,
                color: dominantColor || 0xd51007,
                image: { url: finalAlbumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/") },
                footer: {
                    text: `Searched by: ${interaction.member!.user.username}`,
                    icon_url: iconUrl
                }
            };
            await sendFinalResponse(interaction, { embeds: [embed] });
        } else {
            let content = `Could not find album art for \`${initialSearchQuery}\`.`;
            if (searchQueries.length > 1) {
                content += ` (also tried \`${normalizedQuery}\`).`;
            }
            await sendFinalResponse(interaction, { content });
        }
    } catch (error) {
        console.error(error);
        await sendFinalResponse(interaction, { content: 'An error occurred while processing your request.' });
    }
}

async function handleUserScrobble(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string) {
    // Defer the reply immediately.
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });
    
    // --- NEW: Read options ---
    const options = interaction.data.options ?? [];
    const youtubeScrobbleOption = options.find(opt => opt.name === 'youtube_scrobble') as APIApplicationCommandInteractionDataBooleanOption | undefined;
    const applyYoutubeScrobbleFix = youtubeScrobbleOption?.value === false ? false : true;

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks?.track.length) {
            await sendFinalResponse(interaction, { content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` });
            return;
        }
        
        const track = data.recenttracks.track[0];
        let artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];

        // --- NEW: Apply YouTube Scrobble Fix ---
        if (applyYoutubeScrobbleFix && artist.endsWith(' - Topic')) {
            artist = artist.replace(' - Topic', '').trim();
            console.log(`Applied YouTube scrobble fix. Original: "${track.artist['#text']}", Corrected: "${artist}"`);
        }

        const primaryUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]?.['#text'];

        // Use the same reliable function to get the cover.
        const albumArtUrl = await getVerifiedAlbumArtUrl(primaryUrl, artist, albumName);

        if (!albumArtUrl) {
            await sendFinalResponse(interaction, { content: `Could not find album art for **${trackName}** by **${artist}**.` });
            return;
        }

        const dominantColor = await getDominantColor(albumArtUrl);
        const baseUrl = getBaseUrl();
        const hexColor = (dominantColor || 0xd51007).toString(16).padStart(6, '0');
        const iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
        
        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;

        const embed = {
            title: albumName,
            description: `-# by **${artist}**`,
            color: dominantColor || 0xd51007,
            image: { url: albumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/") },
            footer: { text: footerText, icon_url: iconUrl }
        };

        await sendFinalResponse(interaction, { embeds: [embed] });
    } catch (error) {
        console.error(error);
        await sendFinalResponse(interaction, { content: 'An error occurred while fetching data from Last.fm.' });
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
                    flags: 1 << 6, // Ephemeral message
                },
            });
        }
        await handleUserScrobble(interaction, lastfmUsername);
    }
    
    // We have handled the response by deferring and then patching, so we return 204.
    return new NextResponse(null, { status: 204 });
}