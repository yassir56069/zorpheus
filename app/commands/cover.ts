// app/commands/cover.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
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

async function findCoverOnMusicBrainz(artist: string, album: string): Promise<string | null> {  
    const userAgent = process.env.MUSICBRAINZ_USER_AGENT;
    if (!userAgent) {
        console.log("MusicBrainz User-Agent not set, skipping this fallback.");
        return null;
    }

    try {
        // Step A: Search MusicBrainz for the release to get its ID (MBID)
        const musicBrainzUrl = `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(album)}%20AND%20artist:${encodeURIComponent(artist)}&fmt=json`;
        
        const mbResponse = await fetch(musicBrainzUrl, {
            headers: { 'User-Agent': userAgent }
        });

        if (!mbResponse.ok) {
            console.error(`MusicBrainz API returned status: ${mbResponse.status}`);
            return null;
        }

        const mbData = await mbResponse.json();
        
        // Find the most likely match (usually the first result)
        const release = mbData.releases?.[0];
        const releaseId = release?.id; // This is the MBID

        if (!releaseId) {
            console.log(`No release ID found on MusicBrainz for ${artist} - ${album}`);
            return null;
        }

        // Step B: Use the release ID to get the cover art from the Cover Art Archive
        const coverArtUrl = `https://coverartarchive.org/release/${releaseId}`;
        const caResponse = await fetch(coverArtUrl);
        
        // If the cover art archive returns a 404, it means no art exists for this release.
        if (!caResponse.ok) {
            return null;
        }
        
        const caData = await caResponse.json();
        // The API returns an array of images. We want the front cover.
        const frontImage = caData.images?.find((img: { front: boolean; }) => img.front);
        
        if (frontImage?.image) {
            console.log("Successfully got album art from Cover Art Archive.");
            // This URL points directly to the highest-resolution image they have.
            return frontImage.image;
        }

    } catch (error) {
        console.error("Error fetching from MusicBrainz/Cover Art Archive:", error);
    }
    
    return null;
}

// This helper function remains unchanged
async function findCoverArt(artist: string, album: string): Promise<string | null> {
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
            console.log(`Successfully got album art from iTunes. ${highResUrl}`);
            return highResUrl;
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }

    // --- Fallback 2: MusicBrainz / Cover Art Archive ---
    // This will only run if iTunes returned nothing.
    console.log("iTunes failed, trying MusicBrainz / Cover Art Archive...");
    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (musicBrainzArt) {
        return musicBrainzArt;
    }

    // If all fallbacks have failed, return null.
    console.log(`All fallbacks failed for "${album}" by "${artist}".`);
    return null;
}

async function getDominantColor(imageUrl: string): Promise<number | null> {
    try {
        const palette = await Vibrant.from(imageUrl).getPalette();
        // We'll prioritize the "Vibrant" swatch, but you can choose others
        // like Muted, DarkVibrant, etc.
        const vibrantSwatch = palette.Vibrant || palette.Muted || palette.LightVibrant;

        if (vibrantSwatch && vibrantSwatch.hex) {
            // Discord requires the color as a decimal (integer), not a hex string.
            // We parse the hex string (e.g., "#RRGGBB") into an integer.
            return parseInt(vibrantSwatch.hex.substring(1), 16);
        }
    } catch (error) {
        console.error("Error getting dominant color:", error);
    }
    // Return null if we fail, so we can use a fallback color
    return null;
}

const getBaseUrl = () => {
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    // Use the public URL from your .env file for local dev or previews
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:2999';
};

async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, initialSearchQuery: string) {
    // Immediately defer the reply
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({
            type: InteractionResponseType.DeferredChannelMessageWithSource,
        }),
        headers: {
            'Content-Type': 'application/json',
        },
    });

    const apiKey = process.env.LASTFM_API_KEY;
    
    let finalAlbumArtUrl: string | null = null;
    let finalArtist: string | null = null;
    let finalAlbumName: string | null = null;
    
    const searchQueries = [initialSearchQuery];
    const normalizedQuery = normalizeString(initialSearchQuery);

    // Only add the normalized query if it's different from the original
    if (normalizedQuery !== initialSearchQuery) {
        searchQueries.push(normalizedQuery);
    }

    try {
        // Loop through search queries (original, then normalized if different)
        for (const query of searchQueries) {
            console.log(`--- Searching for: "${query}" ---`);
            
            // Step 1: Try Last.fm first
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(query)}&api_key=${apiKey}&format=json&limit=1`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            // If Last.fm gives no result, skip to the next query (normalized)
            if (data.error || !data.results?.albummatches?.album?.[0]) {
                console.log(`Last.fm found no results for "${query}".`);
                continue; 
            }
            
            const album = data.results.albummatches.album[0];
            const artist = album.artist;
            const albumName = album.name;

            let albumArtUrl = album.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
                            || album.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
                            || album.image[album.image.length - 1]?.['#text'];
            
            // Step 2: Check if the Last.fm URL is valid
            if (await isValidImageUrl(albumArtUrl)) {
                console.log(`Found valid cover on Last.fm for "${query}".`);
                finalAlbumArtUrl = albumArtUrl;
            } else {
                // Step 3: If Last.fm URL is bad, try all other fallbacks (iTunes, MusicBrainz)
                console.log(`Last.fm URL for "${query}" is invalid or a placeholder. Trying fallbacks...`);
                finalAlbumArtUrl = await findCoverArt(artist, albumName);
            }

            // If we found a cover from any source, store the details and stop searching.
            if (finalAlbumArtUrl) {
                finalArtist = artist;
                finalAlbumName = albumName;
                break;
            }
        }

        // --- Process the final result ---
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
            // All attempts (original and normalized) have failed.
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

async function handleUserScrobble(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string) {
    // Immediately defer the reply
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({
            type: InteractionResponseType.DeferredChannelMessageWithSource,
        }),
        headers: {
            'Content-Type': 'application/json',
        },
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
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            return;
        }
        
        const track = data.recenttracks.track[0];
        const artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];
        let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
        || track.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
        || track.image[track.image.length - 1]?.['#text'];
        
        const isLastFmUrlValid = await isValidImageUrl(albumArtUrl);

        if (!isLastFmUrlValid) {
            console.log('Last.fm URL for user scrobble is invalid or timed out. Trying fallback...');
            albumArtUrl = await findCoverArt(artist, albumName);
        }

        if (!albumArtUrl) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content: `Could not find album art for **${trackName}** by **${artist}**.` }),
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            return;
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

        albumArtUrl = albumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");
        
        const embed = {
            title: albumName,
            description: `-# by **${artist}**`,
            color: dominantColor || 0xd51007,
            image: { url: albumArtUrl },
            footer: {
                text: footerText,
                icon_url: iconUrl
            }
        };

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ embeds: [embed] }),
            headers: {
                'Content-Type': 'application/json',
            },
        });


    } catch (error) {
        console.error(error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: 'An error occurred while fetching data from Last.fm.' }),
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }
}

export async function handleCover(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options;

    // --- Search Mode ---
    if (options && options.length > 0) {
        const searchOption = options[0] as APIApplicationCommandInteractionDataStringOption;
        if (searchOption.name === 'search') {
            await handleAlbumSearch(interaction, searchOption.value);
            return new NextResponse(null, { status: 204 }); // We've handled the response, so just return a success status
        }
    }

    // --- User Mode (Default) ---
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
    
    await handleUserScrobble(interaction, lastfmUsername);
    return new NextResponse(null, { status: 204 });
}