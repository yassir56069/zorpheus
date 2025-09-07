import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import sharp from 'sharp';
import path from 'path';
import { createCanvas, registerFont } from 'canvas';

// --- All of your existing code (font registration, types, helper functions) remains the same ---
// --- I will omit it here for brevity, but you should keep it in your file. ---

// Define a type for the album data from the Last.fm API
type Album = {
    name: string;
    artist: {
        name: string;
    };
    image: { '#text': string, size: string }[];
    playcount: string; // playcount from API is a string
};

// Define a new type for our aggregated data
type AggregatedAlbum = {
    name: string;
    artist: {
        name: string;
    };
    image: { '#text': string, size: string }[];
    playcount: number; // We will store playcount as a number
};


// ... [Your existing generateTextBuffer, fetchImageBuffer, and createChartImage functions go here] ...


/**
 * Handles the logic for the /serverchart command.
 */
export async function handleServerChart(interaction: APIChatInputApplicationCommandInteraction) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const options = (interaction.data.options || []) as APIApplicationCommandInteractionDataStringOption[];
    const sizeOption = options.find(opt => opt.name === 'size')?.value || '3x3';
    const [gridWidth, gridHeight] = sizeOption.split('x').map(Number);
    const limit = gridWidth * gridHeight;
    const displayStyle = options.find(opt => opt.name === 'labelling')?.value || 'no_names';
    const period = options.find(opt => opt.name === 'period')?.value || '7day';
    const apiKey = process.env.LASTFM_API_KEY;

    try {
        // 1. Get all registered Last.fm usernames from Vercel KV
        const userKeys: string[] = [];
        for await (const key of kv.scanIterator()) {
            // Assuming keys are Discord User IDs
            userKeys.push(key);
        }

        if (userKeys.length === 0) {
            const content = 'No users have registered their Last.fm accounts with `/register` yet.';
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const lastfmUsernames = (await kv.mget(...userKeys)) as string[];

        // 2. Fetch top albums for all users concurrently
        const fetchPromises = lastfmUsernames.map(username => {
            if (!username) return null;
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&period=${period}&api_key=${apiKey}&format=json&limit=100`; // Fetch more albums per user
            return fetch(apiUrl).then(res => res.json());
        }).filter(Boolean);

        const results = await Promise.allSettled(fetchPromises);

        // 3. Aggregate the data
        const albumScrobbles = new Map<string, AggregatedAlbum>();

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.topalbums) {
                const albums: Album[] = result.value.topalbums.album;
                for (const album of albums) {
                    const key = `${album.artist.name.toLowerCase()} - ${album.name.toLowerCase()}`;
                    const playCount = parseInt(album.playcount, 10);

                    if (albumScrobbles.has(key)) {
                        albumScrobbles.get(key)!.playcount += playCount;
                    } else {
                        albumScrobbles.set(key, {
                            ...album,
                            playcount: playCount,
                        });
                    }
                }
            }
        }

        if (albumScrobbles.size === 0) {
            const content = 'Could not fetch any album data for registered users in this period.';
             await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        // 4. Sort by scrobbles and get the top albums
        const sortedAlbums = Array.from(albumScrobbles.values())
            .sort((a, b) => b.playcount - a.playcount)
            .slice(0, limit);

        if (sortedAlbums.length < limit) {
             const content = `Not enough unique albums listened to by the server to generate a ${sizeOption} chart. Found ${sortedAlbums.length} albums.`;
             await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        // 5. Generate the chart image (reusing your existing function)
        const chartImageBuffer = await createChartImage(sortedAlbums, gridWidth, gridHeight, displayStyle);

        const formData = new FormData();
        formData.append('file', new Blob([chartImageBuffer]), 'server-chart.png');
        
        const periodDisplayNames: { [key: string]: string } = {
            '7day': 'Last 7 Days', '1month': 'Last Month', '3month': 'Last 3 Months',
            '6month': 'Last 6 Months', '12month': 'Last Year', 'overall': 'All Time'
        };
        
        const serverName = interaction.guild?.name || 'This Server';
        const content = `-# *Server Top Albums (${periodDisplayNames[period]}) - **${serverName}***`;
        formData.append('payload_json', JSON.stringify({ content }));

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: formData,
        });

    } catch (error) {
        console.error("Server Chart command error:", error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: 'An error occurred while generating the server chart.' }),
            headers: { 'Content-Type': 'application/json' },
        });
    }

    return new NextResponse(null, { status: 204 });
}