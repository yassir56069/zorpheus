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
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';

// --- NEW HELPER FUNCTION ---

/**
 * A robust, case-insensitive filter to remove " - Topic" from an artist string.
 * Includes clear logging to show when it's being applied.
 * @param artist The original artist name from Last.fm.
 * @returns The cleaned artist name.
 */
function cleanArtistName(artist: string): string {
    const originalArtist = artist;
    // Use a case-insensitive, global regex to find and replace all occurrences of " - Topic"
    const topicPattern = /\s-\sTopic/gi;
    const cleanedArtist = artist.replace(topicPattern, '').trim();

    if (cleanedArtist !== originalArtist) {
        console.log(`[Artist Filter] Applied. Original: "${originalArtist}", Cleaned: "${cleanedArtist}"`);
    } else {
        // This log helps confirm the function ran even if no change was needed.
        console.log(`[Artist Filter] No change needed for artist: "${originalArtist}"`);
    }
    return cleanedArtist;
}


// --- EXISTING HELPER FUNCTIONS (UNCHANGED) ---

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
        if (!caResponse.ok) {
            return null;
        }
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
    if (musicBrainzArt) {
        return musicBrainzArt;
    }

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

// --- MAIN COMMAND HANDLER (REVISED) ---

export async function handleFm(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];
    const usernameOption = options.find(opt => opt.name === 'username') as APIApplicationCommandInteractionDataStringOption | undefined;
    const youtubeScrobbleOption = options.find(opt => opt.name === 'youtube_scrobble') as APIApplicationCommandInteractionDataBooleanOption | undefined;
    const applyYoutubeScrobbleFix = youtubeScrobbleOption?.value !== false;

    let lastfmUsername: string | null = null;
    const discordUserId = interaction.member!.user.id;
    
    if (usernameOption) {
        lastfmUsername = usernameOption.value;
    } else {
        lastfmUsername = await kv.get(discordUserId) as string | null;
    }

    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first, or provide a username directly with \`/fm username: <username>\`.`,
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
        
        // Apply the cleaning function to the artist name
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
            // --- CRITICAL FIX: Return a NextResponse to prevent crashing ---
            return new NextResponse(null, { status: 204 });
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

        const components = [{
            type: 1,
            components: [{
                type: 2,
                style: ButtonStyle.Secondary,
                label: 'Re-sync',
                custom_id: `resync_fm_${interaction.member!.user.id}`,
            }],
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
                body: JSON.stringify({ components: [] }),
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

// --- BUTTON HANDLER (REVISED) ---

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
    const lastfmUsername = await kv.get(discordUserId) as string | null;
    const apiKey = process.env.LASTFM_API_KEY;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

    if (!lastfmUsername) {
        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: "It seems you're no longer registered. Please use `/register`.", embeds: [], components: [] }),
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
                body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`.`, embeds: [] }),
            });
            return new NextResponse(null, { status: 204 });
        }

        const track = data.recenttracks.track[0];
        let artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];

        // Always apply the fix on resync
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
            // --- CRITICAL FIX: Return a NextResponse to prevent crashing ---
            return new NextResponse(null, { status: 204 });
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

        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
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