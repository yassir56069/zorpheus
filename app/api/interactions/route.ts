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
import { handleCover, handleCoverButtonInteraction } from '@/app/commands/cover';
import { handleFm, handleFmResync } from '@/app/commands/fm'; 
import { handleCountdown, handleCountdownInteraction  } from '@/app/commands/countdown';

// development 
import { handleDev } from '@/app/sandbox/dev';
import { handleProfile } from '@/app/commands/profile';
import { handleChart, handleServerChart } from '@/app/commands/chart';
import { handleRc } from '@/app/commands/rc';
import { handleLeague } from '@/app/commands/league';

const BANNED_GUILD_ID = '1373961525890514964'; // heehee

export async function POST(req: Request) {
    const { isValid, interaction } = await verifyDiscordRequest(req, process.env.DISCORD_PUBLIC_KEY!);

    if (!isValid || !interaction) {
        return new NextResponse('Invalid request signature', { status: 401 });
    }

    if (interaction.type === InteractionType.Ping) {
        return NextResponse.json({ type: InteractionResponseType.Pong });
    }

    if (interaction.guild_id === BANNED_GUILD_ID) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "🛑🦇**ZORPHEUS has been decommissioned from SOUND AND VISIONE and will no longer respond to commands here.. LONG! LIVE! GOONDOLIN!** 🛑🦇 \n-# If you're reading this, I'm working on ratings for the bot for a new server, dm me if you're interested ;;;)) Love you all <3\n-# Sincerely, the Zorpheus Lifeblood 🩸🩸",
                flags: 64,
            },
        });
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
                return await handleServerChart(interaction as APIChatInputApplicationCommandInteraction);
            case 'league': 
                return handleLeague(interaction as APIChatInputApplicationCommandInteraction)
            case 'rc': 
                return handleRc(interaction as APIChatInputApplicationCommandInteraction);
            case 'dev':
                return handleDev(interaction as APIChatInputApplicationCommandInteraction);

            default:
                return new NextResponse('Unknown command', { status: 400 });
        }
    }

    if (interaction.type === InteractionType.MessageComponent) {
        const componentInteraction = interaction as APIMessageComponentButtonInteraction;
        const customId = componentInteraction.data.custom_id;

        // --- NEW: Route fm button interactions ---
        if (customId.startsWith('resync_fm_')) {
            return handleFmResync(componentInteraction);
        }

        // --- NEW: Route cover buttons ---
        if (customId.startsWith('cov_')) {
            return handleCoverButtonInteraction(componentInteraction);
        }

        // Existing handler for countdown buttons
        if (customId.startsWith('countdown_')) { // Example prefix for your countdown buttons
             return handleCountdownInteraction(componentInteraction);
        }

        return new NextResponse('Unhandled component interaction', { status: 400 });
    }

    return new NextResponse('Unhandled interaction type', { status: 404 });
}