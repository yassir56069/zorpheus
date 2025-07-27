// app/commands/ping.ts
import { NextResponse } from 'next/server';
import { InteractionResponseType, APIApplicationCommandInteraction } from 'discord-api-types/v10';

export async function handlePing(interaction: APIApplicationCommandInteraction) {
    const interactionId = BigInt(interaction.id);
    const creationTimestamp = Number((interactionId >> BigInt(22)) + BigInt('1420070400000'));
    const latency = Date.now() - creationTimestamp;

    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: `🏓 Pong! Latency is ${latency}ms.` },
    });
}