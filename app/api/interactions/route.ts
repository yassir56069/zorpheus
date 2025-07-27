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

    // "cover" command logic
    if (name === 'cover') {
      // Get the username from the command's options
      const usernameOption = options?.[0] as APIApplicationCommandInteractionDataStringOption;
      const username = usernameOption.value;

      const apiKey = process.env.LASTFM_API_KEY;
      const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${apiKey}&format=json&limit=1`;
      
      try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        // Error handling for Last.fm API
        if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
          return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `Could not find any recent tracks for user \`${username}\`. Make sure your profile is public.` },
          });
        }
        
        const track = data.recenttracks.track[0];

        // Check if the track is currently playing
        if (!track['@attr'] || !track['@attr'].nowplaying) {
          return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `\`${username}\` is not listening to anything right now.` },
          });
        }

        const artist = track.artist['#text'];
        const trackName = track.name;
        // Find the 'extralarge' image, or fall back to the last available image
        const albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]['#text'];
        
        // If for some reason there's no image at all
        if (!albumArtUrl) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Could not find album art for "${trackName}" by ${artist}.` },
            });
        }
        
        // Create a Discord Embed
        const embed = {
          title: trackName,
          description: `by **${artist}**`,
          color: 0xd51007, // Last.fm red
          image: {
            url: albumArtUrl,
          },
          footer: {
            text: `Currently listening: ${username}`,
            icon_url: 'https://cdn.icon-icons.com/icons2/2345/PNG/512/lastfm_logo_icon_142718.png'
          }
        };

        return NextResponse.json({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            embeds: [embed],
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