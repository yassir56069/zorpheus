// app/commands/fm.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    APIMessageComponentButtonInteraction,
    ButtonStyle,
    ComponentType,
    APIActionRowComponent,
    APIButtonComponent,
    MessageFlags,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';

// --- HELPER FUNCTIONS (These can remain unchanged) ---

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
        const mbResponse = await fetch(musicBrainzUrl, {
            headers: { 'User-Agent': userAgent }
        });
        if (!mbResponse.ok) {
            console.error(`MusicBrainz API returned status: ${mbResponse.status}`);
            return null;
        }
        const mbData = await mbResponse.json();
        const releaseId = mbData.releases?.[0]?.id;
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

// --- MAIN COMMAND HANDLER ---

export async function handleFm(interaction: APIChatInputApplicationCommandInteraction) {
    let lastfmUsername: string | null = null;
    const discordUserId = interaction.member!.user.id;
    lastfmUsername = await kv.get(discordUserId) as string | null;

    if (!lastfmUsername){
        if (interaction.data.options && interaction.data.options.length > 0) {
            const usernameOption = interaction.data.options[0] as APIApplicationCommandInteractionDataStringOption;
            lastfmUsername = usernameOption.value;
        } 
    }

    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first, or provide a username directly with \`/fm username: <username>\`.`,
                flags: MessageFlags.Ephemeral,
            },
        });
    }

    // --- MODIFICATION 1 ---
    // Defer the response ephemerally. This makes the "Thinking..." message and all
    // subsequent edits (follow-ups) visible ONLY to the person who ran the command.
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: InteractionResponseType.DeferredChannelMessageWithSource,
            data: {
                flags: MessageFlags.Ephemeral,
            },
        }),
    });

    const apiKey = process.env.LASTFM_API_KEY;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
    
    try {
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
        const artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];
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

        // --- MODIFICATION 2 ---
        // We add the current timestamp to the custom ID. This lets us check
        // if the button has expired when a user clicks it.
        const creationTimestamp = Date.now();
        const components: APIActionRowComponent<APIButtonComponent>[] = [{
            type: ComponentType.ActionRow,
            components: [{
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                label: 'Re-sync',
                custom_id: `resync_fm_${interaction.member!.user.id}_${creationTimestamp}`,
            }],
        }];

        await fetch(webhookUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed], components }),
        });

        // --- MODIFICATION 3 ---
        // The problematic `setTimeout` is removed completely. The timeout logic is now
        // handled when the button is clicked, which is compatible with Vercel.

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

// --- BUTTON INTERACTION HANDLER ---

export async function handleFmResync(interaction: APIMessageComponentButtonInteraction) {
    const [_, __, originalUserId, creationTimestampStr] = interaction.data.custom_id.split('_');
    const creationTimestamp = parseInt(creationTimestampStr);
    const EXPIRATION_MS = 60 * 1000; // 60 seconds

    // Security Check: Ensure the person clicking is the one who ran the command.
    if (interaction.member!.user.id !== originalUserId) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "This button isn't for you!",
                flags: MessageFlags.Ephemeral,
            },
        });
    }

    // Timeout Check: If it's been over a minute, tell the user and remove the button.
    if (Date.now() - creationTimestamp > EXPIRATION_MS) {
        await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: {
                    content: "This re-sync button has expired. Please run the command again.",
                    flags: MessageFlags.Ephemeral,
                },
            }),
        });
        
        // Edit the original message to remove the now-expired button.
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ components: [] }),
        });
        
        return new NextResponse(null, { status: 204 });
    }

    // Acknowledge the button click immediately so Discord knows we're working.
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: InteractionResponseType.DeferredMessageUpdate }),
    });

    // --- Re-run the core scrobble logic ---
    const lastfmUsername = await kv.get(originalUserId) as string | null;
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
        const artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];
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

        // Update the original message with the new embed. The button remains.
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