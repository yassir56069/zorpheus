// app/api/interactions/route.ts
import { NextResponse } from 'next/server';
import {
  InteractionType,
  InteractionResponseType,
  APIInteraction,
} from 'discord-api-types/v10';
import { verifyKey } from 'discord-interactions';

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
  const { isValid, interaction } = await verifyRequest(req, process.env.DISCORD_PUBLIC_KEY!);

  if (!isValid || !interaction) {
    return new NextResponse('Invalid request signature', { status: 401 });
  }

  if (interaction.type === InteractionType.Ping) {
    return NextResponse.json({ type: InteractionResponseType.Pong });
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    const { name } = interaction.data;

    if (name === 'ping') {
      return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: 'Pong!',
        },
      });
    }
  }

  return new NextResponse('Unhandled interaction type', { status: 404 });
}