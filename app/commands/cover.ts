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
        // We use a 'HEAD' request because we only care if the image exists,
        // not about its content. This is much faster than a 'GET'.
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        
        // Clear the timeout if the request completes successfully
        clearTimeout(timeoutId);

        // response.ok is true for status codes 200-299
        return response.ok;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            // This happens when our timeout is triggered
            console.log(`Image URL timed out: ${url}`);
        } else {
            // This can happen for other network reasons (CORS, DNS errors, etc.)
            console.error(`Error fetching image URL head: ${url}`, error);
        }
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
            const highResUrl = bestMatch.artworkUrl100.replace('100x100', '1000x1000');
            console.log(`Found potential cover on iTunes: ${highResUrl}`);
            return highResUrl;
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }
    return null;
}

async function findCoverOnMusicBrainz(artist: string, album: string): Promise<string | null> {  
    const userAgent = process.env.MUSICBRAINZ_USER_AGENT;
    if (!userAgent) {
        console.log("MusicBrainz User-Agent not set, skipping this fallback.");
        return null;
    }

    try {
        const musicBrainzUrl = `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(album)}%20AND%20artist:${encodeURIComponent(artist)}&fmt=json`;
        
        const mbResponse = await fetch(musicBrainzUrl, {
            headers: { 'User-Agent': userAgent }
        });

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
        const caResponse = await fetch(coverArtUrl, { headers: { 'Accept': 'application/json' } });
        
        if (!caResponse.ok) {
            return null;
        }
        
        const caData = await caResponse.json();
        const frontImage = caData.images?.find((img: { front: boolean; }) => img.front);
        
        if (frontImage?.image) {
            console.log("Found potential cover on Cover Art Archive.");
            return frontImage.image;
        }

    } catch (error) {
        console.error("Error fetching from MusicBrainz/Cover Art Archive:", error);
    }
    
    return null;
}

/**
 * The original fallback logic. Tries sources one-by-one and returns the first valid image.
 */
async function findCoverArtSequentially(artist: string, album: string): Promise<string | null> {
    console.log(`Searching fallbacks sequentially for "${album}" by "${artist}"`);
    
    const itunesArt = await findCoverOnItunes(artist, album);
    if (await isValidImageUrl(itunesArt)) {
        console.log("Successfully got valid album art from iTunes.");
        return itunesArt;
    }

    console.log("iTunes failed or returned invalid image, trying MusicBrainz...");
    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (await isValidImageUrl(musicBrainzArt)) {
        console.log("Successfully got valid album art from MusicBrainz.");
        return musicBrainzArt;
    }

    console.log(`All sequential fallbacks failed for "${album}" by "${artist}".`);
    return null;
}

/**
 * [HQ Only] Fetches album art from all available sources in parallel.
 */
async function findAllCoverArtSources(artist: string, album: string, lastfmUrl: string | null): Promise<(string | null)[]> {
    console.log(`[HQ] Searching all sources for "${album}" by "${artist}"`);
    
    const sourcePromises = [
        Promise.resolve(lastfmUrl), // Include the initial Last.fm URL
        findCoverOnItunes(artist, album),
        findCoverOnMusicBrainz(artist, album),
    ];

    const results = await Promise.all(sourcePromises);
    return results.filter(url => url); // Filter out nulls
}

/**
 * [HQ Only] Assigns a quality score to an image URL based on known patterns.
 */
function getImageQualityScore(url: string | null): number {
    if (!url) return 0;

    if (url.includes('coverartarchive.org')) return 5000; // Highest priority

    const match = url.match(/(\d+)x\d+/);
    if (match && match[1]) {
        return parseInt(match[1], 10);
    }
    
    // Fallback for standard last.fm URLs
    if (url.includes('/i/u/')) {
        if (url.includes('300x300')) return 300;
        if (url.includes('174s')) return 174;
    }

    return 100; // Default low score
}

/**
 * [HQ Only] Takes a list of URLs, checks their validity, and returns the one with the highest quality score.
 */
async function getBestImageUrl(urls: (string | null)[]): Promise<string | null> {
    const validUrls = [];
    for (const url of urls) {
        if (await isValidImageUrl(url)) {
            validUrls.push(url!);
        }
    }

    if (validUrls.length === 0) return null;

    validUrls.sort((a, b) => getImageQualityScore(b) - getImageQualityScore(a));

    console.log("Ranked image URLs by quality:", validUrls.map(u => ({ url: u, score: getImageQualityScore(u) })));

    return validUrls[0];
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

async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, initialSearchQuery: string, hqOnly: boolean) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    
    let finalAlbumArtUrl: string | null = null;
    let finalArtist: string | null = null;
    let finalAlbumName: string | null = null;
    
    const searchQueries = [initialSearchQuery];
    const normalizedQuery = normalizeString(initialSearchQuery);

    if (normalizedQuery !== initialSearchQuery) {
        searchQueries.push(normalizedQuery);
    }

    try {
        for (const query of searchQueries) {
            console.log(`--- Searching for: "${query}" ---`);
            
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(query)}&api_key=${apiKey}&format=json&limit=1`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            if (data.error || !data.results?.albummatches?.album?.[0]) {
                console.log(`Last.fm found no results for "${query}".`);
                continue; 
            }
            
            const album = data.results.albummatches.album[0];
            const artist = album.artist;
            const albumName = album.name;

            const lastfmAlbumArtUrl = album.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
                                   || album.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
                                   || album.image[album.image.length - 1]?.['#text'];
            
            if (hqOnly) {
                console.log("HQ mode enabled. Gathering all sources.");
                const allUrls = await findAllCoverArtSources(artist, albumName, lastfmAlbumArtUrl);
                finalAlbumArtUrl = await getBestImageUrl(allUrls);
            } else {
                if (await isValidImageUrl(lastfmAlbumArtUrl)) {
                    console.log(`Found valid cover on Last.fm for "${query}".`);
                    finalAlbumArtUrl = lastfmAlbumArtUrl;
                } else {
                    console.log(`Last.fm URL for "${query}" is invalid or a placeholder. Trying fallbacks...`);
                    finalAlbumArtUrl = await findCoverArtSequentially(artist, albumName);
                }
            }

            if (finalAlbumArtUrl) {
                finalArtist = artist;
                finalAlbumName = albumName;
                break;
            }
        }

        if (finalAlbumArtUrl && finalArtist && finalAlbumName) {
            const dominantColor = await getDominantColor(finalAlbumArtUrl);
            const baseUrl = getBaseUrl();
            let iconUrl = `${baseUrl}/api/recolor-icon?color=d51007`;
            if (dominantColor) {
                const hexColor = dominantColor.toString(16).padStart(6, '0');
                iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
            }
            
            finalAlbumArtUrl = finalAlbumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");

            const embed = {
                title: finalAlbumName,
                description: `-# by **${finalArtist}**`,
                color: dominantColor || 0xd51007,
                image: { url: finalAlbumArtUrl },
                footer: {
                    text: `Searched by: ${interaction.member!.user.username}`,
                    icon_url: iconUrl
                }
            };
            
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ embeds: [embed] }),
                headers: { 'Content-Type': 'application/json' },
            });
        } else {
            let content = `Could not find album art for \`${initialSearchQuery}\`.`;
            if (searchQueries.length > 1) {
                content = `Could not find album art for \`${initialSearchQuery}\` (also tried \`${normalizedQuery}\`).`;
            }

            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content }),
                headers: { 'Content-Type': 'application/json' },
            });
        }

    } catch (error) {
        console.error(error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: 'An error occurred while processing your request.' }),
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

async function handleUserScrobble(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string, hqOnly: boolean) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` }),
                headers: { 'Content-Type': 'application/json' },
            });
            return;
        }
        
        const track = data.recenttracks.track[0];
        const artist = track.artist['#text'];
        const albumName = track.album['#text'];
        const lastfmAlbumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
                                || track.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
                                || track.image[track.image.length - 1]?.['#text'];
        
        let finalAlbumArtUrl: string | null = null;

        if (hqOnly) {
            console.log("HQ mode enabled for scrobble. Gathering all sources.");
            const allUrls = await findAllCoverArtSources(artist, albumName, lastfmAlbumArtUrl);
            finalAlbumArtUrl = await getBestImageUrl(allUrls);
        } else {
            if (await isValidImageUrl(lastfmAlbumArtUrl)) {
                finalAlbumArtUrl = lastfmAlbumArtUrl;
            } else {
                console.log('Last.fm URL for user scrobble is invalid. Trying sequential fallbacks...');
                finalAlbumArtUrl = await findCoverArtSequentially(artist, albumName);
            }
        }

        if (!finalAlbumArtUrl) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find album art for **${track.name}** by **${artist}**.` }),
                headers: { 'Content-Type': 'application/json' },
            });
            return;
        }

        const dominantColor = await getDominantColor(finalAlbumArtUrl);
        const baseUrl = getBaseUrl();
        let iconUrl = 'https://www.last.fm/static/images/lastfm_avatar_twitter.52a5d69a85ac.png';
        if (dominantColor) {
            const hexColor = dominantColor.toString(16).padStart(6, '0');
            iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
        }
        
        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;

        finalAlbumArtUrl = finalAlbumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");
        
        const embed = {
            title: albumName,
            description: `-# by **${artist}**`,
            color: dominantColor || 0xd51007,
            image: { url: finalAlbumArtUrl },
            footer: {
                text: footerText,
                icon_url: iconUrl
            }
        };

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ embeds: [embed] }),
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error(error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: 'An error occurred while fetching data from Last.fm.' }),
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

export async function handleCover(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options as (APIApplicationCommandInteractionDataStringOption | APIApplicationCommandInteractionDataBooleanOption)[] | undefined;

    const searchOption = options?.find(opt => opt.name === 'search') as APIApplicationCommandInteractionDataStringOption | undefined;
    const hqOnlyOption = options?.find(opt => opt.name === 'hq_only') as APIApplicationCommandInteractionDataBooleanOption | undefined;
    const hqOnly = hqOnlyOption?.value ?? false;

    // --- Search Mode ---
    if (searchOption?.value) {
        await handleAlbumSearch(interaction, searchOption.value, hqOnly);
        return new NextResponse(null, { status: 204 });
    }

    // --- User Mode (Default, can also have hqOnly flag) ---
    const discordUserId = interaction.member!.user.id;
    const lastfmUsername = await kv.get(discordUserId) as string | null;

    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `To see your last played track, you must register your Last.fm username with the \`/register\` command first. Or, use the \`/cover search:<album name>\` option to find an album.`,
                flags: 1 << 6, // Ephemeral message
            },
        });
    }
    
    await handleUserScrobble(interaction, lastfmUsername, hqOnly);
    return new NextResponse(null, { status: 204 });
}