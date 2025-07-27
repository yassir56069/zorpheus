// app/commands/cover.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import { Vibrant } from 'node-vibrant/node';


// This helper function remains unchanged
async function findCoverArt(artist: string, album: string, size: number = 1000): Promise<string | null> {
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
        const response = await fetch(itunesUrl);
        const data = await response.json();

        if (data.resultCount > 0) {
            const bestMatch = data.results.find((r: { collectionName: string; }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];
            // Use the provided size for the URL
            return bestMatch.artworkUrl100.replace('100x100', `${size}x${size}`);
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

const getBaseUrl = () => {
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    // Use the public URL from your .env file for local dev or previews
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:2999';
};

/**
 * Handles the logic when a user searches for a specific album.
 */
async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, searchQuery: string) {
    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(searchQuery)}&api_key=${apiKey}&format=json&limit=1`;
    
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.results?.albummatches?.album?.[0]) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Could not find any results for album: \`${searchQuery}\`.` },
            });
        }
        
        const album = data.results.albummatches.album[0];
        const albumName = album.name;
        const artist = album.artist;
        let albumArtUrl = album.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || album.image[album.image.length - 1]?.['#text'];
        
        if (!albumArtUrl) {
            albumArtUrl = await findCoverArt(artist, albumName);
        }

        if (!albumArtUrl) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Could not find album art for **${albumName}** by **${artist}**.` },
            });
        }

        const dominantColor = await getDominantColor(albumArtUrl);
        const baseUrl = getBaseUrl();
        let iconUrl = `${baseUrl}/api/recolor-icon?color=d51007`; // Default grey for search
        if (dominantColor) {
            const hexColor = dominantColor.toString(16).padStart(6, '0');
            iconUrl = `${baseUrl}/api/recolor-icon?color=${hexColor}`;
        }
        
        const embed = {
            title: albumName,
            description: `*by **${artist}***`,
            color: dominantColor || 0xd51007,
            image: { url: albumArtUrl },
            footer: {
                text: `Searched by: ${interaction.member!.user.username}`,
                icon_url: iconUrl
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

/**
 * Handles the logic for fetching a user's last scrobbled track.
 */
async function handleUserScrobble(interaction: APIChatInputApplicationCommandInteraction, lastfmUsername: string) {
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
        let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]?.['#text'];
        
        if (!albumArtUrl) {
            albumArtUrl = await findCoverArt(artist, albumName);
        }

        if (!albumArtUrl) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Could not find album art for **${trackName}** by **${artist}**.` },
            });
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
        
        const embed = {
            title: albumName,
            description: `**${trackName}**\n*by **${artist}***`,
            color: dominantColor || 0xd51007,
            image: { url: albumArtUrl },
            footer: {
                text: footerText,
                icon_url: iconUrl
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

export async function handleCover(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options;

    // --- Search Mode ---
    if (options && options.length > 0) {
        const searchOption = options[0] as APIApplicationCommandInteractionDataStringOption;
        if (searchOption.name === 'search') {
            return handleAlbumSearch(interaction, searchOption.value);
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
    
    return handleUserScrobble(interaction, lastfmUsername);
}