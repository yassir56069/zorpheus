// app/api/interactions/route.ts
import { NextResponse } from 'next/server';
import {
  InteractionType,
  InteractionResponseType,
  APIInteraction,
  APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { verifyKey } from 'discord-interactions';
import { verifyDiscordRequest } from '@/utils/verify-discord-request';
import { kv } from '@vercel/kv';

// (This is our verification function from before)
async function verifyRequest(req: Request, publicKey: string) {
    const signature = req.headers.get('x-signature-ed25519');
    const timestamp = req.headers.get('x-signature-timestamp');
    const body = await req.text();

    if (!signature || !timestamp) {
        return { isValid: false, interaction: null };
    }
    
    const isValid = verifyKey(body, signature, timestamp, publicKey);
    
    return { isValid, interaction: await isValid ? (JSON.parse(body) as APIInteraction) : null };
}

async function findCoverArt(artist: string, album: string, track: string): Promise<string | null> {
  // Try iTunes API first (Apple Music)
  try {
    const searchTerm = `${artist} ${album}`;
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
    const response = await fetch(itunesUrl);
    const data = await response.json();

    if (data.resultCount > 0) {
      // Find the best match - sometimes the first result isn't the album.
      const bestMatch = data.results.find((r: { collectionName: string; }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];

      // iTunes provides a 100x100px thumbnail. We can get a high-res version by replacing '100x100' in the URL.
      const highResUrl = bestMatch.artworkUrl100.replace('100x100', '1000x1000');
      return highResUrl;
    }
  } catch (error) {
    console.error("Error fetching from iTunes:", error);
  }

  // If you wanted to add another fallback like TheAudioDB, it would go here.
  // For now, we'll return null if iTunes fails.
  return null;
}

export async function POST(req: Request) {
    const { isValid, interaction } = await verifyDiscordRequest(req, process.env.DISCORD_PUBLIC_KEY!);

    if (!isValid || !interaction) {
        return new NextResponse('Invalid request signature', { status: 401 });
    }

    if (interaction.type === InteractionType.Ping) {
        return NextResponse.json({ type: InteractionResponseType.Pong });
    }

    if (interaction.type === InteractionType.ApplicationCommand) {
        const { name, options } = interaction.data;

    // "ping" command logic
    if (name === 'ping') {
        const interactionId = BigInt(interaction.id);
        const creationTimestamp = Number((interactionId >> BigInt(22)) + BigInt('1420070400000'));
        const latency = Date.now() - creationTimestamp;
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `🏓 Pong! Latency is ${latency}ms.` },
        });
    }

    if (name === 'register') {
        const discordUserId = interaction.member!.user.id;
        const usernameOption = options?.[0] as APIApplicationCommandInteractionDataStringOption;
        const lastfmUsername = usernameOption.value;

        await kv.set(discordUserId, lastfmUsername);

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `✅ Success! Your Last.fm username has been saved as \`${lastfmUsername}\`.` },
        });
    }

    // "cover" command logic
    if (name === 'cover') {
        let lastfmUsername: string | null = null;
        // User ID is the unique key for our database
        const discordUserId = interaction.member!.user.id;
          const application_id = interaction.application_id;
        const interaction_token = interaction.token
        
        // First, check if a username was explicitly provided in the command options
        if (options && options.length > 0) {
            const usernameOption = options[0] as APIApplicationCommandInteractionDataStringOption;
            lastfmUsername = usernameOption.value;
        } else {
            // If not, try to retrieve the username from our Vercel KV store
            lastfmUsername = await kv.get(discordUserId);
        }

        // If we still don't have a username after both checks, the user needs to register.
        if (!lastfmUsername) {
            return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first, or provide a username directly with \`/cover username: <username>\`.`,
                // ephemeral message flag
                flags: 1 << 6,
            },
            });
        }

          // Define the function to send the follow-up embed
            const sendFollowup = async (embed: any) => {
                const followupUrl = `https://discord.com/api/v10/webhooks/${application_id}/${interaction_token}`;
                await fetch(followupUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeds: [embed] }),
                });
            };

        
        // Now, proceed with the Last.fm API call using the determined username
        const apiKey = process.env.LASTFM_API_KEY;
        const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
        
        try {
            const response = await fetch(apiUrl);
            const data = await response.json();

            // Handle case where Last.fm user doesn't exist or has no tracks
            if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Could not find any recent tracks for user \`${lastfmUsername}\`. Make sure the profile is public and the username is correct.` },
            });
            }
            
            const track = data.recenttracks.track[0];

            // Check if the user is currently playing a song
            if (!track['@attr'] || !track['@attr'].nowplaying) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `\`${lastfmUsername}\` is not listening to anything right now.` },
            });
            }

            const artist = track.artist['#text'];
            const trackName = track.name;
            const albumName = track.album['#text'];
            // Find the 'extralarge' image, or fall back to the last available image as a safety measure
            let albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]?.['#text'];

            

            // Handle the rare case where lastfm fails 
            if (!albumArtUrl) {
                albumArtUrl = await findCoverArt(artist, albumName, trackName);
            }
            
            const originalImageUrl = albumArtUrl.replace(/\/\d+x\d+\//, "/");

            const embed = {
            title: trackName,
            description: `by **${artist}**\n*from ${albumName || 'Unknown Album'}*`,
            color: 0xd51007,
            footer: {
                text: `Currently listening: ${lastfmUsername}`,
                icon_url: 'https://cdn.icon-icons.com/icons2/2345/PNG/512/lastfm_logo_icon_142718.png'
            }
            };
            
            // 4. Send the follow-up message with the embed FIRST
            await sendFollowup(embed);

            // 5. If we found an image, send it as the INITIAL response.
            // Otherwise, send a text confirmation as the initial response.
            const initialResponseContent = albumArtUrl || "Here's your track info:";
            
            return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: initialResponseContent,
            },
        });

        } catch (error) {
            console.error(error);
            return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'An error occurred while fetching data from Last.fm.' },
            });
        }
    }
}
return new NextResponse('Unhandled interaction type', { status: 404 });
}