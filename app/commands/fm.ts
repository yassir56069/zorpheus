// app/commands/fm.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';

// --- HELPER FUNCTIONS (These can remain unchanged) ---

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
    console.log("All fallbacks failed.");
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

// --- MAIN COMMAND HANDLER (REVISED) ---

export async function handleFm(interaction: APIChatInputApplicationCommandInteraction) {
    // --- Step 1: Resolve Username (Fast Operation) ---
    let lastfmUsername: string | null = null;
    const discordUserId = interaction.member!.user.id;

    lastfmUsername = await kv.get(discordUserId) as string | null;

    if (!lastfmUsername){
        if (interaction.data.options && interaction.data.options.length > 0) {
            const usernameOption = interaction.data.options[0] as APIApplicationCommandInteractionDataStringOption;
            lastfmUsername = usernameOption.value;
        } 
    }

    // --- Step 2: Handle Unregistered User (Fast Path) ---
    // If no username is found, we can respond immediately with an ephemeral message.
    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first, or provide a username directly with \`/fm username: <username>\`.`,
                flags: 1 << 6, // Ephemeral message
            },
        });
    }

    // --- Step 3: Defer the Interaction (Slow Path) ---
    // A username exists, so we will be performing slow operations.
    // Immediately send a "thinking..." state to Discord.
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: InteractionResponseType.DeferredChannelMessageWithSource,
        }),
    });

    // --- Step 4: Perform Long-Running Operations ---
    const apiKey = process.env.LASTFM_API_KEY;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
    
    try {
        const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
        const response = await fetch(apiUrl);
        const data = await response.json();

        // Handle case where user or tracks are not found
        if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
            await fetch(webhookUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` }),
            });
            return new NextResponse(null, { status: 204 });
        }

        const track = data.recenttracks.track[0];
        const artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];

        // Fetch optional track duration
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

        let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
            || track.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
            || track.image[track.image.length - 1]?.['#text'];


        const isLastFmUrlValid = await isValidImageUrl(albumArtUrl);

        if (!isLastFmUrlValid) {
            console.log('Last.fm URL for user scrobble is invalid or timed out. Trying fallback...');
            albumArtUrl = await findCoverArt(artist, albumName);
        }

        if (albumArtUrl == 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png') // lastfm placeholder image
        {
            console.log('LastFM returned placeholder, trying fallback...');
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


        const dominantColor = albumArtUrl ? await getDominantColor(albumArtUrl) : null;
        
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
            footer: {
                text: footerText,
                icon_url: iconUrl,
            },
        };

        // --- Step 5: Send the Final Follow-up Message ---
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
        });

    } catch (error) {
        console.error(error);
        // Send a generic error message if anything in the try block fails
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'An error occurred while fetching data from Last.fm.' }),
        });
    }

    // --- Step 6: Return a final response to Vercel ---
    // We've already handled responding to Discord via fetch.
    // Now we just need to tell Vercel the function is done.
    return new NextResponse(null, { status: 204 });
};