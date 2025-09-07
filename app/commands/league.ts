
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';

// --- Define necessary types ---

type LastFmArtist = {
    name: string;
    playcount: string;
};

type AggregatedArtist = {
    name: string;
    playcount: number;
};

type SpotifyTrack = {
    name: string;
    artists: { name: string }[];
};

// --- Spotify API Helper Functions ---

/**
 * Fetches an access token from the Spotify API using the Client Credentials Flow.
 */
async function getSpotifyToken(): Promise<string> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Spotify API credentials are not configured in environment variables.');
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
        },
        body: 'grant_type=client_credentials'
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(`Spotify token fetch failed: ${data.error_description}`);
    }
    return data.access_token;
}

/**
 * Fetches all tracks from a Spotify playlist, handling pagination automatically.
 * @param playlistId The ID of the Spotify playlist.
 * @param token The Spotify API access token.
 */
async function getPlaylistTracks(playlistId: string, token: string): Promise<SpotifyTrack[]> {
    const allTracks: SpotifyTrack[] = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=50&fields=items(track(name,artists(name))),next`;

    while (url) {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            // Handle cases like private or non-existent playlists
            if (response.status === 404) throw new Error('Spotify playlist not found or is private.');
            throw new Error(`Failed to fetch playlist tracks: ${response.statusText}`);
        }
        
        const data = await response.json();
        // yes I can't be bothered fixing these type issues.. pay me!
        const tracks = data.items
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((item: { track: any; }) => item.track) // Filter out any null track objects
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((item: { track: { name: any; artists: any[]; }; }) => ({
                name: item.track.name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                artists: item.track.artists.map((artist: { name: any; }) => ({ name: artist.name }))
            }));

        allTracks.push(...tracks);
        url = data.next; // URL for the next page of results, or null if it's the last page
    }
    return allTracks;
}

/**
 * Extracts the playlist ID from various Spotify URL formats.
 * @param url The full Spotify playlist URL.
 */
function extractPlaylistId(url: string): string | null {
    const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}

/**
 * Fetches the server's top 30 artists from Last.fm, using a cache.
 * Returns a sorted array of artist names.
 */
async function getServerTopArtists(): Promise<string[]> {
    const cacheKey = 'league:server-top-artists-list'; // Use a new key that stores a simple array
    const cachedArtists: string[] | null = await kv.get(cacheKey);

    if (cachedArtists) {
        console.log("CACHE HIT: Using cached Last.fm server artists list.");
        return cachedArtists;
    }

    console.log("CACHE MISS: Fetching fresh Last.fm server artists.");
    const userKeys: string[] = [];
    for await (const key of kv.scanIterator()) { userKeys.push(key); }
    if (userKeys.length === 0) { throw new Error('No users have registered with `/register`.'); }

    const lastfmUsernames = (await kv.mget(...userKeys)) as string[];
    const apiKey = process.env.LASTFM_API_KEY;

    const fetchPromises = lastfmUsernames.map(username => {
        if (!username) return null;
        const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${username}&period=1month&api_key=${apiKey}&format=json&limit=50`;
        return fetch(apiUrl).then(res => res.json());
    }).filter(Boolean);

    const results = await Promise.allSettled(fetchPromises);
    const artistScrobbles = new Map<string, AggregatedArtist>();

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.topartists) {
            const artists: LastFmArtist[] = result.value.topartists.artist;
            for (const artist of artists) {
                const key = artist.name.toLowerCase();
                const playCount = parseInt(artist.playcount, 10);
                if (artistScrobbles.has(key)) {
                    artistScrobbles.get(key)!.playcount += playCount;
                } else {
                    artistScrobbles.set(key, { name: artist.name, playcount: playCount });
                }
            }
        }
    }

    const sortedArtists = Array.from(artistScrobbles.values())
        .sort((a, b) => b.playcount - a.playcount)
        .slice(0, 30)
        .map(artist => artist.name); // We want the proper capitalization

    if (sortedArtists.length > 0) {
        // Cache the sorted list of names for 1 hour
        await kv.set(cacheKey, sortedArtists, { ex: 3600 });
    }

    return sortedArtists;
}

/**
 * --- MODIFIED: Handles the logic for the /league subcommands. ---
 */
export async function handleLeague(interaction: APIChatInputApplicationCommandInteraction) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const subcommand = (interaction.data.options?.[0] as any); // The subcommand object

        // --- Subcommand Router ---
 if (subcommand.name === 'banned') {
            const topArtists = await getServerTopArtists();

            if (topArtists.length === 0) {
                throw new Error("Could not find any top artists for the server.");
            }

            // --- EMBED LOGIC START ---

            // 1. Split the artist list into two halves
            const firstHalf = topArtists.slice(0, 15);
            const secondHalf = topArtists.slice(15, 30);

            // 2. Format each half into a numbered string
            // The `\u200b` is a zero-width space to prevent an empty field error if the list is empty
            const firstFieldValue = firstHalf.map((artist, index) => `${index + 1}. ${artist}`).join('\n') || '\u200b';
            const secondFieldValue = secondHalf.map((artist, index) => `${index + 16}. ${artist}`).join('\n') || '\u200b';

            // 3. Construct the embed object
            const embed = {
                title: "🚫 Server League Banned Artists",
                description: "The following artists have the highest scrobbles on the server this month and are banned from the league.",
                color: 0xED4245, // Discord's red color
                fields: [
                    {
                        name: "Artists 1-15",
                        value: firstFieldValue,
                        inline: true // This makes the fields appear side-by-side
                    },
                    {
                        name: "Artists 16-30",
                        value: secondFieldValue,
                        inline: true
                    }
                ],
                footer: {
                    text: `Based on plays from the last 30 days.`
                }
            };

            // Remove the second field if there are 15 or fewer artists
            if (secondHalf.length === 0) {
                embed.fields.pop();
                 // If there's only one column, it looks better not being inline
                embed.fields[0].inline = false;
            }

            // 4. Send the embed in the response
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ embeds: [embed] }),
                headers: { 'Content-Type': 'application/json' },
            });

        } else if (subcommand.name === 'find') {
            const playlistUrl = subcommand.options?.find((opt: { name: string; }) => opt.name === 'playlist')?.value;
            if (!playlistUrl) { throw new Error("Playlist URL was not provided."); }
            
            const playlistId = extractPlaylistId(playlistUrl);
            if (!playlistId) { throw new Error("That doesn't look like a valid Spotify playlist URL."); }

            // 1. Get server top artists (from our new helper function)
            const topArtists = await getServerTopArtists();
            if (topArtists.length === 0) { throw new Error("Could not fetch any artist data for the server's registered users."); }
            const topArtistSet = new Set(topArtists.map(a => a.toLowerCase()));

            // 2. Get Spotify tracks (with caching)
            const playlistCacheKey = `league:playlist:${playlistId}`;
            let playlistTracks: SpotifyTrack[] | null = await kv.get(playlistCacheKey);
            if (!playlistTracks) {
                const spotifyToken = await getSpotifyToken();
                playlistTracks = await getPlaylistTracks(playlistId, spotifyToken);
                await kv.set(playlistCacheKey, playlistTracks, { ex: 300 });
            }

            // 3. Find matches
            const matchingTracks = playlistTracks!.filter(track => 
                track.artists.some(artist => topArtistSet.has(artist.name.toLowerCase()))
            );

            // 4. Format and send response
            let content = '';
            if (matchingTracks.length === 0) {
                content = "Found no tracks in the playlist from the server's top 30 most listened to artists this month.";
            } else {
                content = `Found **${matchingTracks.length}** tracks from the server's top artists in the playlist:\n\n`;
                const trackList = matchingTracks
                    .map((track, i) => {
                        const artistNames = track.artists.map(a => a.name).join(', ');
                        return `${i + 1}. **${track.name}** by ${artistNames}`;
                    })
                    .join('\n');
                
                // Truncate if the message is too long for Discord
                if ((content.length + trackList.length) > 2000) {
                    content += trackList.substring(0, 1900) + "\n...and more.";
                } else {
                    content += trackList;
                }
            }

            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content }),
                headers: { 'Content-Type': 'application/json' },
            });
        }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        console.error("League command error:", error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: `An error occurred: ${error.message}` }),
            headers: { 'Content-Type': 'application/json' },
        });
    }

    return new NextResponse(null, { status: 204 });
}