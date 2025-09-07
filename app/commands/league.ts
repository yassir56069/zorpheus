
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
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
 * Handles the logic for the /league command.
 */
export async function handleLeague(interaction: APIChatInputApplicationCommandInteraction) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    try {
        const options = (interaction.data.options || []) as APIApplicationCommandInteractionDataStringOption[];
        const playlistUrl = options.find(opt => opt.name === 'playlist')?.value;

        if (!playlistUrl) {
            throw new Error("Playlist URL was not provided.");
        }
        
        const playlistId = extractPlaylistId(playlistUrl);
        if (!playlistId) {
            const content = 'That doesn\'t look like a valid Spotify playlist URL. Please provide a valid URL.';
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }


        // --- Part 1: Get Server's Top 30 Last.fm Artists (1 Month) ---
        const userKeys: string[] = [];
        for await (const key of kv.scanIterator()) {
            userKeys.push(key);
        }

        if (userKeys.length === 0) {
            throw new Error('No users have registered with `/register`.');
        }

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
        
        const top30ArtistNames = new Set(
            Array.from(artistScrobbles.values())
                .sort((a, b) => b.playcount - a.playcount)
                .slice(0, 30)
                .map(artist => artist.name.toLowerCase())
        );

        if (top30ArtistNames.size === 0) {
            throw new Error("Could not fetch any artist data for the server's registered users.");
        }

        // --- Part 2: Get Spotify Playlist Tracks ---
        const spotifyToken = await getSpotifyToken();
        const playlistTracks = await getPlaylistTracks(playlistId, spotifyToken);

        // --- Part 3: Find Matching Tracks ---
        const matchingTracks: string[] = [];
        for (const track of playlistTracks) {
            const hasMatchingArtist = track.artists.some(artist => top30ArtistNames.has(artist.name.toLowerCase()));
            if (hasMatchingArtist) {
                const artistNames = track.artists.map(a => a.name).join(', ');
                matchingTracks.push(`**${track.name}** by ${artistNames}`);
            }
        }

        // --- Part 4: Format and Send Response ---
        let content = '';
        if (matchingTracks.length === 0) {
            content = "Found no tracks in the playlist from the server's top 30 most listened to artists this month.";
        } else {
            content = `Found **${matchingTracks.length}** tracks from the server's top artists in the playlist:\n\n`;
            let trackList = matchingTracks.map((track, i) => `${i + 1}. ${track}`).join('\n');

            if (content.length + trackList.length > 2000) {
                const remaining = matchingTracks.length - 25; // Approximate
                trackList = matchingTracks.slice(0, 25).map((track, i) => `${i + 1}. ${track}`).join('\n');
                trackList += `\n...and ${remaining} more.`;
            }
            content += trackList;
        }

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content }),
            headers: { 'Content-Type': 'application/json' },
        });


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