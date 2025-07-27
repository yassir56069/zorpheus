// app/api/interactions/route.ts
import { NextResponse } from 'next/server';
import {
    InteractionType,
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { verifyDiscordRequest } from '@/utils/verify-discord-request';

// Import command handlers
import { handlePing } from '@/app/commands/ping';
import { handleRegister } from '@/app/commands/register';
import { handleCover } from '@/app/commands/cover';
import { handleFm } from '@/app/commands/fm';

export async function POST(req: Request) {
    const { isValid, interaction } = await verifyDiscordRequest(req, process.env.DISCORD_PUBLIC_KEY!);

    if (!isValid || !interaction) {
        return new NextResponse('Invalid request signature', { status: 401 });
    }

    if (interaction.type === InteractionType.Ping) {
        return NextResponse.json({ type: InteractionResponseType.Pong });
    }

    if (interaction.type === InteractionType.ApplicationCommand) {
        const { name } = interaction.data;

        // Command router
        switch (name) {
            case 'ping':
                return handlePing(interaction as APIChatInputApplicationCommandInteraction);
            case 'register':
                return handleRegister(interaction as APIChatInputApplicationCommandInteraction);
            case 'cover':
                return handleCover(interaction as APIChatInputApplicationCommandInteraction);
            case 'fm':
                return handleFm(interaction as APIChatInputApplicationCommandInteraction);
            default:
                return new NextResponse('Unknown command', { status: 400 });
        }
    }

    return new NextResponse('Unhandled interaction type', { status: 404 });
}