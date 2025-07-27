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
        const discordUserId = interaction.member!.user.id;
        
        // Check for provided username or fetch from KV
        if (options && options.length > 0) {
            const usernameOption = options[0] as APIApplicationCommandInteractionDataStringOption;
            lastfmUsername = usernameOption.value;
        } else {
            lastfmUsername = await kv.get(discordUserId);
        }

        // Handle case where user is not registered
        if (!lastfmUsername) {
            return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first.`,
                flags: 1 << 6, // Ephemeral message
            },
            });
        }
        
        const apiKey = process.env.LASTFM_API_KEY;
        const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${apiKey}&format=json&limit=1`;
        
        try {
            const response = await fetch(apiUrl);
            const data = await response.json();

            // Error handling for Last.fm API response
            if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) { /* ... */ }
            const track = data.recenttracks.track[0];
            if (!track['@attr'] || !track['@attr'].nowplaying) { /* ... */ }

            const artist = track.artist['#text'];
            const trackName = track.name;
            const albumArtUrl = track.image.find((img: { size: string; }) => img.size === 'extralarge')?.['#text'] || track.image[track.image.length - 1]?.['#text'];
            
            if (!albumArtUrl) { /* ... */ }
            
            // --- THIS IS THE NEW AND IMPORTANT PART ---

            // 1. Remove the size specifier from the URL to get the original image
            const originalImageUrl = albumArtUrl.replace(/\/\d+x\d+\//, "/");

            // 2. Create the embed without the image property
            const embed = {
            title: trackName,
            description: `by **${artist}**`,
            color: 0xd51007, // Last.fm red
            footer: {
                text: `Currently listening: ${lastfmUsername}`,
                icon_url: 'https://cdn.icon-icons.com/icons2/2345/PNG/512/lastfm_logo_icon_142718.png'
            }
            };

            // 3. Send a response containing the ORIGINAL image URL and the embed
            return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: originalImageUrl, // Use the new, cleaned-up URL
                embeds: [embed],
            },
            });

        } catch (error) {
            console.error(error);
            return NextResponse.json({ /* ... error handling ... */ });
        }
    }
}
return new NextResponse('Unhandled interaction type', { status: 404 });
}