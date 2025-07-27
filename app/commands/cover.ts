// app/commands/cover.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import Vibrant from 'node-vibrant';

// This helper function remains unchanged
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


export async function handleCover(interaction: APIChatInputApplicationCommandInteraction) {
    let lastfmUsername: string | null = null;
    const discordUserId = interaction.member!.user.id;

    if (interaction.data.options && interaction.data.options.length > 0) {
        const usernameOption = interaction.data.options[0] as APIApplicationCommandInteractionDataStringOption;
        lastfmUsername = usernameOption.value;
    } else {
        lastfmUsername = await kv.get(discordUserId);
    }

    if (!lastfmUsername) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first, or provide a username directly with \`/cover username: <username>\`.`,
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
                data: { content: `Could not find any recent tracks for user \`${lastfmUsername}\`. Make sure the profile is public and the username is correct.` },
            });
        }

        const track = data.recenttracks.track[0];

        // This block has been removed! The code will now continue regardless of listening status.

        const artist = track.artist['#text'];
        const trackName = track.name;
        const albumName = track.album['#text'];
        let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]?.['#text'];


        albumArtUrl = albumArtUrl.replace(/\/\d+x\d+\//, "/");

        if (!albumArtUrl) {
            albumArtUrl = await findCoverArt(artist, albumName);
            
            // If still no cover art after fallback, send a message
            if (!albumArtUrl) {
                return NextResponse.json({
                    type: InteractionResponseType.ChannelMessageWithSource,
                    data: { content: `Could not find album art for **${trackName}** by **${artist}**.` },
                });
            }
        }
        
        const dominantColor = await getDominantColor(albumArtUrl);
        const isNowPlaying = track['@attr']?.nowplaying;
        const footerText = isNowPlaying
            ? `Currently listening: ${lastfmUsername}`
            : `Last scrobbled by: ${lastfmUsername}`;

        const embed = {
            title: albumName,
            // ✨ NEW: Add the track name to the description for more context
            description: `*by **${artist}***`,
            color: dominantColor ||0xd51007, // Last.fm red
            image: { url: albumArtUrl },
            footer: {
                text: footerText, // Use our new dynamic text
                icon_url: 'https://www.last.fm/static/images/lastfm_avatar_twitter.52a5d69a85ac.png'
            }
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
}