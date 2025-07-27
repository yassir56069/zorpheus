// app/api/interactions/route.ts
import {
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
} from 'discord-interactions';
import { NextResponse } from 'next/server';
import { verifyKey } from 'discord-interactions';

export async function POST(req: Request) {
  // You must verify the request signature from Discord
  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');
  const body = await req.text();

  const isValidRequest = verifyKey(
    body,
    signature!,
    timestamp!,
    process.env.DISCORD_PUBLIC_KEY!
  );

  if (!isValidRequest) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  // Parse the interaction body
  const interaction = JSON.parse(body);

  // Handle Discord's PING request
  if (interaction.type === InteractionType.PING) {
    return NextResponse.json({ type: InteractionResponseType.PONG });
  }

  // Handle the slash command
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name } = interaction.data;

    // "ping" command
    if (name === 'ping') {
      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: 'Pong!',
        },
      });
    }
  }

  // Default response for unhandled interactions
  return new NextResponse('Unhandled interaction', { status: 404 });
}