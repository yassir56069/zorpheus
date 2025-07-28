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


// --- MAIN COMMAND HANDLER (REVISED) ---

export async function handleFm(interaction: APIChatInputApplicationCommandInteraction) {
    // --- Step 1: Resolve Username (Fast Operation) ---
    let lastfmUsername: string | null = null;
    const discordUserId = interaction.member!.user.id;

    if (interaction.data.options && interaction.data.options.length > 0) {
        const usernameOption = interaction.data.options[0] as APIApplicationCommandInteractionDataStringOption;
        lastfmUsername = usernameOption.value;
    } else {
        lastfmUsername = await kv.get(discordUserId) as string | null;
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
            type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
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

        const albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text']
            || track.image.find((img: { size: string; }) => img.size === 'large')?.['#text']
            || track.image[track.image.length - 1]?.['#text'];

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