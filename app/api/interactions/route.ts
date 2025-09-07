// app/api/interactions/route.ts
import { NextResponse } from 'next/server';
import {
    InteractionType,
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIMessageComponentButtonInteraction,
} from 'discord-api-types/v10';
import { verifyDiscordRequest } from '@/utils/verify-discord-request';

// Import command handlers
import { handlePing } from '@/app/commands/ping';
import { handleRegister } from '@/app/commands/register';
import { handleCover } from '@/app/commands/cover';
import { handleFm } from '@/app/commands/fm';
import { handleCountdown, handleCountdownInteraction  } from '@/app/commands/countdown';

// development 
import { handleDev } from '@/app/sandbox/dev';
import { handleProfile } from '@/app/commands/profile';
import { handleChart, handleServerChart } from '@/app/commands/chart';
import { handleRc } from '@/app/commands/rc';

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
            case 'countdown': 
                return handleCountdown(interaction as APIChatInputApplicationCommandInteraction);
            case 'profile': 
                return handleProfile(interaction as APIChatInputApplicationCommandInteraction); 
            case 'chart': 
                return handleChart(interaction as APIChatInputApplicationCommandInteraction);
            case 'serverchart': // Add a case for the new command
                return await handleServerChart(interaction);
            case 'rc': 
                return handleRc(interaction as APIChatInputApplicationCommandInteraction);
            case 'dev':
                return handleDev(interaction as APIChatInputApplicationCommandInteraction);

            default:
                return new NextResponse('Unknown command', { status: 400 });
        }
    }

    if (interaction.type === InteractionType.MessageComponent) {
        // Right now, only the countdown command has buttons, so we can
        // directly pass the interaction to its handler.
        // If you add buttons to other commands, you'll need to add logic here
        // to check the `custom_id` and route to the correct handler.
        return handleCountdownInteraction(interaction as APIMessageComponentButtonInteraction);
    }

    return new NextResponse('Unhandled interaction type', { status: 404 });
}