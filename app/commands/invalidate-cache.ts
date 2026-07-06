import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction
} from 'discord-api-types/v10';
import { invalidateCaches } from '@/utils/database/album-service';

// If you want to lock this to a single developer's Discord user ID, you can define it here.
const DEVELOPER_USER_ID = ''; // Optional: Put your Discord User ID here

export async function handleInvalidateCache(interaction: APIChatInputApplicationCommandInteraction) {
    const actingUser = interaction.member?.user || interaction.user;
    const actingUserId = actingUser?.id;

    // 1. Optional strict Developer ID check (uncomment if you want to lock it solely to your account)
    /*
    if (DEVELOPER_USER_ID && actingUserId !== DEVELOPER_USER_ID) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "❌ This command is restricted to the bot owner.",
                flags: 64 // Ephemeral (visible only to the user)
            }
        });
    }
    */

    // 2. Fallback checking if the user has administrator permissions on Discord
    // Using parseInt to avoid BigInt literal compilation issues on Vercel
    const permissions = parseInt(interaction.member?.permissions || '0', 10);
    const isAdmin = (permissions & 8) === 8; // 8 is the ADMINISTRATOR permission bit

    if (!isAdmin) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "❌ You do not have permission to run this command.",
                flags: 64
            }
        });
    }

    try {
        await invalidateCaches();

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "♻️ **Ranking and global average caches have been invalidated.** The next query to the rankings will trigger a fresh calculation.",
                flags: 64
            }
        });
    } catch (error) {
        console.error("[ADMIN] Error invalidating caches:", error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: "❌ A database error occurred while trying to invalidate caches.",
                flags: 64
            }
        });
    }
}