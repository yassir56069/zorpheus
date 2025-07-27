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

// Initialize the KV client to connect to your Vercel KV store
const kv = createClient({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// Verification function to ensure requests are from Discord
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

// Main function to handle all incoming interactions from Discord
export async function POST(req: Request) {
  const { isValid, interaction } = await verifyRequest(req, process.env.DISCORD_PUBLIC_KEY!);

  if (!isValid || !interaction) {
    return new NextResponse('Invalid request signature', { status: 401 });
  }

  // Handle Discord's PING check for endpoint verification
  if (interaction.type === InteractionType.Ping) {
    return NextResponse.json({ type: InteractionResponseType.Pong });
  }

  // Handle Application Commands (Slash Commands)
  if (interaction.type === InteractionType.ApplicationCommand) {
    if (interaction.data.type === ApplicationCommandType.ChatInput) {
      const { name, options } = interaction.data;

      // Logic for the "/ping" command
      if (name === 'ping') {
        const interactionId = BigInt(interaction.id);
        const creationTimestamp = Number((interactionId >> BigInt(22)) + BigInt('1420070400000'));
        const latency = Date.now() - creationTimestamp;
        return NextResponse.json({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: `🏓 Pong! Latency is ${latency}ms.` },
        });
      }

      // Logic for the "/register" command
      if (name === 'register') {
        const discordUserId = interaction.member!.user.id;
        const usernameOption = options?.[0] as APIApplicationCommandInteractionDataStringOption;
        const lastfmUsername = usernameOption.value;

        // Save the mapping of Discord ID -> Last.fm username in Vercel KV
        await kv.set(discordUserId, lastfmUsername);

        return NextResponse.json({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: `✅ Success! Your Last.fm username has been saved as \`${lastfmUsername}\`.`,
            flags: 1 << 6, // Ephemeral message (only visible to the user)
          },
        });
      }

      // Logic for the "/cover" command using the deferral system
      if (name === 'cover') {
        // This async function will run in the background
        (async () => {
          const applicationId = interaction.application_id;
          const interactionToken = interaction.token;
          
          const editUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;
          const followupUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`;

          try {
            let lastfmUsername: string | null = null;
            const discordUserId = interaction.member!.user.id;

            if (options && options.length > 0) {
              const usernameOption = options[0] as APIApplicationCommandInteractionDataStringOption;
              lastfmUsername = usernameOption.value;
            } else {
              lastfmUsername = await kv.get(discordUserId);
            }

            if (!lastfmUsername) {
              await fetch(editUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first.`,
                  flags: 1 << 6,
                }),
              });
              return;
            }

            const apiKey = process.env.LASTFM_API_KEY;
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
                await fetch(editUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `Could not find any recent tracks for user \`${lastfmUsername}\`. Make sure the profile is public.` }) });
                return;
            }
            
            const track = data.recenttracks.track[0];

            if (!track['@attr'] || !track['@attr'].nowplaying) {
                await fetch(editUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `\`${lastfmUsername}\` is not listening to anything right now.` }) });
                return;
            }
            
            const artist = track.artist['#text'];
            const trackName = track.name;
            const albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]?.['#text'];
            
            if (!albumArtUrl) {
                await fetch(editUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `Could not find album art for "${trackName}" by ${artist}.` }) });
                return;
            }

            const originalImageUrl = albumArtUrl.replace(/\/\d+x\d+\//, "/");

            // First message: Edit the original "thinking..." message to be just the image
            await fetch(editUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: originalImageUrl }),
            });

            // Create the text-only embed
            const embed = {
              title: trackName,
              description: `by **${artist}**`,
              color: 0xd51007,
              footer: {
                text: `Currently listening: ${lastfmUsername}`,
                icon_url: 'https://cdn.icon-icons.com/icons2/2345/PNG/512/lastfm_logo_icon_142718.png',
              },
            };

            // Second message: Send a brand new follow-up message with the embed
            await fetch(followupUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ embeds: [embed] }),
            });

          } catch (err) {
            console.error('Error in cover command:', err);
            // Fallback error message if anything goes wrong
            try {
              await fetch(editUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: 'Sorry, an unexpected error occurred.' }),
              });
            } catch (e) {
              console.error('Failed to send error message:', e);
            }
          }
        })(); // Immediately invoke the async function

        // Immediately return the DEFER response
        return NextResponse.json({
          type: InteractionResponseType.DeferredChannelMessageWithSource,
        });
      }
    }
  }

  return new NextResponse('Unhandled interaction type', { status: 404 });
}