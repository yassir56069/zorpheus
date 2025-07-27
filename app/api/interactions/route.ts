// app/api/interactions/route.ts
import {
  InteractionType,
  InteractionResponseType,
} from 'discord-interactions';
import { NextResponse } from 'next/server';
import { verifyKey } from 'discord-interactions';

export async function POST(req: Request) {
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

  const interaction = JSON.parse(body);

  // Handle Discord's PING request for endpoint verification
  if (interaction.type === InteractionType.PING) {
    // THIS IS THE MODIFIED LINE
    return NextResponse.json({ type: 1 }); 
  }

  // Handle the slash command
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name } = interaction.data;

    if (name === 'ping') {
      return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: 'Pong!',
        },
      });
    }
  }

  return new NextResponse('Unhandled interaction', { status: 404 });
}