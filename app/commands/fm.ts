// app/commands/fm.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';

// --- HELPER FUNCTIONS (Copied from cover.ts for consistency) ---

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
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
};


// --- MAIN COMMAND HANDLER ---

export async function handleFm(interaction: APIChatInputApplicationCommandInteraction) {
    let lastfmUsername: string | null = null;
    const discordUserId = interaction.member!.user.id;

    // Check if a username was provided as an option
    if (interaction.data.options && interaction.data.options.length > 0) {
        const usernameOption = interaction.data.options[0] as APIApplicationCommandInteractionDataStringOption;
        lastfmUsername = usernameOption.value;
    } else {
        // If not, fall back to the registered username in KV
        lastfmUsername = await kv.get(discordUserId) as string | null;
    }

    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first, or provide a username directly with \`/fm username: <username>\`.`,
                flags: 1 << 6, // Ephemeral message
            },
        });
    }

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;

    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Could not find any recent tracks for user \`${lastfmUsername}\`.` },
            });
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

            // The duration is in milliseconds in this endpoint.
            const durationMs = trackInfoData?.track?.duration;
            if (durationMs && parseInt(durationMs) > 0) {
                const durationSeconds = Math.floor(parseInt(durationMs) / 1000);
                const minutes = Math.floor(durationSeconds / 60);
                const seconds = durationSeconds % 60;
                // Pad seconds with a leading zero if needed (e.g., 3:05)
                formattedDuration = `⏱ (${minutes}:${seconds.toString().padStart(2, '0')})`;
            }
        } catch (e) {
            console.error("Could not fetch track duration:", e);
            // Fail silently and just omit the duration if the API call fails.
        }
        
        // For a thumbnail, we want a smaller image. 'large' (174x174) is a good choice.
        const albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
        || track.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
        || track.image[track.image.length - 1]?.['#text'];

        // If for some reason there's absolutely no image, we can still proceed
        // The thumbnail just won't be displayed
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
        const paddingChar = '⠀'; // This is the Braille Pattern Blank character (U+2800)

        const paddingNeeded = Math.max(0, minTitleLength - trackName.length);
        const padding = paddingChar.repeat(paddingNeeded);
        const paddedTitle = trackName + padding;

        // ✨ NEW EMBED STRUCTURE
        const embed = {
            // The title remains the track name
            title: paddedTitle, 
            // The description can be removed or left empty
            description: `${artist} •  ${albumName} \n-# ${formattedDuration}`, 
            color: dominantColor || 0xd51007,
            // The thumbnail stays the same
            thumbnail: {
                url: albumArtUrl,
            },
            footer: {
                text: footerText,
                icon_url: iconUrl,  
            },
        };

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { embeds: [embed] },
        });

    } catch (error) {
        console.error(error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'An error occurred while fetching data from Last.fm.' },
        });
    }
};