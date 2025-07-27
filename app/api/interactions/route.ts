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
        // Defer the initial response immediately.
        const initialResponse = NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });

        // Perform all logic *after* acknowledging the interaction.
        (async () => {
          const application_id = interaction.application_id;
          const interaction_token = interaction.token;
          // URL TO EDIT THE ORIGINAL DEFERRED MESSAGE
          const followupUrl = `https://discord.com/api/v10/webhooks/${application_id}/${interaction_token}/messages/@original`;
          
          try {
            let lastfmUsername: string | null = null;
            if (options && options.length > 0) {
              lastfmUsername = (options[0] as APIApplicationCommandInteractionDataStringOption).value;
            } else {
              lastfmUsername = await kv.get(interaction.member!.user.id);
            }

            if (!lastfmUsername) {
              throw new Error(`You need to register first! Use the \`/register\` command.`);
            }

            const apiKey = process.env.LASTFM_API_KEY;
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
            
            const response = await fetch(apiUrl);
            const data = await response.json();

            if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
              throw new Error(`Could not find any recent tracks for user \`${lastfmUsername}\`.`);
            }
            const trackData = data.recenttracks.track[0];
            if (!trackData['@attr']?.nowplaying) {
              throw new Error(`\`${lastfmUsername}\` is not listening to anything right now.`);
            }

            const artist = trackData.artist['#text'];
            const trackName = trackData.name;
            const albumName = trackData.album['#text'];
            
            let finalAlbumArtUrl: string | null = null;
            const lastfmArt = (trackData.image).find((img: { size: string; }) => img.size === 'extralarge')?.['#text'];
            
            if (lastfmArt) {
              finalAlbumArtUrl = lastfmArt.replace(/\/\d+x\d+\//, "/");
            }
            if (!finalAlbumArtUrl && albumName) {
              finalAlbumArtUrl = await findCoverArt(artist, albumName, trackName);
            }

            // Create the final payload
            const finalPayload = {
              content: finalAlbumArtUrl || "", // Send image as content
              embeds: [{
                title: trackName,
                description: `by **${artist}**\n*from ${albumName || 'Unknown Album'}*`,
                color: 0xd51007,
              }],
            };

            // EDIT the original deferred message
            await fetch(followupUrl, {
              method: 'PATCH', // <-- METHOD IS NOW PATCH
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(finalPayload),
            });

          } catch (e: any) {
            // In case of an error, edit the message to show the error.
            await fetch(followupUrl, {
              method: 'PATCH', // <-- METHOD IS NOW PATCH
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: e.message || "An unknown error occurred." }),
            });
          }
        })();

        // Return the acknowledgment
        return initialResponse;
      }
    }
return new NextResponse('Unhandled interaction type', { status: 404 });
}