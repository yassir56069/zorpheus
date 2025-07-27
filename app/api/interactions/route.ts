// app/api/interactions/route.ts
import { NextResponse } from 'next/server';
import {
  InteractionType,
  InteractionResponseType,
  APIInteraction,
  APIApplicationCommandInteractionDataStringOption,
  ApplicationCommandType,
} from 'discord-api-types/v10';
import { verifyKey } from 'discord-interactions';
import { createClient } from '@vercel/kv';

// --- SETUP ---

// Correctly initialize the KV client using your environment variables
const kv = createClient({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// A single, consistent verification function
async function verifyRequest(req: Request, publicKey: string) {
  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');
  const body = await req.text();
  if (!signature || !timestamp) { return { isValid: false, interaction: null }; }
  const isValid = verifyKey(body, signature, timestamp, publicKey);
  return { isValid, interaction: await isValid ? (JSON.parse(body) as APIInteraction) : null };
}

// Helper function to find cover art from iTunes
async function findCoverArt(artist: string, album: string): Promise<string | null> {
  try {
    const searchTerm = `${artist} ${album}`;
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
    const response = await fetch(itunesUrl);
    const data = await response.json();
    if (data.resultCount > 0) {
      const bestMatch = data.results.find((r: { collectionName: string }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];
      return bestMatch.artworkUrl100.replace('100x100', '1000x1000');
    }
  } catch (error) { console.error("Error fetching from iTunes:", error); }
  return null;
}

// --- MAIN BOT LOGIC ---
export async function POST(req: Request) {
  const { isValid, interaction } = await verifyRequest(req, process.env.DISCORD_PUBLIC_KEY!);

  if (!isValid || !interaction) {
    return new NextResponse('Invalid request signature', { status: 401 });
  }

  if (interaction.type === InteractionType.Ping) {
    return NextResponse.json({ type: InteractionResponseType.Pong });
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    // We only handle ChatInput commands in this bot
    if (interaction.data.type === ApplicationCommandType.ChatInput) {
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

      // "register" command logic
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

        // Perform all async logic after acknowledging the interaction.
        (async () => {
          const application_id = interaction.application_id;
          const interaction_token = interaction.token;
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

            const apiKey = process.env.LASTFM_API_KEY!;
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
            const lastfmArt = (trackData.image as {size: string, '#text': string}[]).find(img => img.size === 'extralarge')?.['#text'];
            
            if (lastfmArt) {
              finalAlbumArtUrl = lastfmArt.replace(/\/\d+x\d+\//, "/");
            }
            if (!finalAlbumArtUrl && albumName) {
              finalAlbumArtUrl = await findCoverArt(artist, albumName);
            }

            const finalPayload = {
              content: finalAlbumArtUrl || "",
              embeds: [{
                title: trackName,
                description: `by **${artist}**\n*from ${albumName || 'Unknown Album'}*`,
                color: 0xd51007,
              }],
            };

            await fetch(followupUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(finalPayload),
            });
        
            // eslint-disable-next-line 
          } catch (e: any) {
            await fetch(followupUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: e.message || "An unknown error occurred." }),
            });
          }
        })();
        
        return initialResponse;
      }
    }
  }

  return new NextResponse('Unhandled interaction type', { status: 404 });
}