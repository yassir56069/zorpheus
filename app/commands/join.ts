import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { db } from '@/utils/db';

export async function handleJoin(interaction: APIChatInputApplicationCommandInteraction) {
    const discordUserId = interaction.member!.user.id;
    const options = interaction.data.options ?? [];

    // Extract options (Make sure your Discord command registration script includes these options!)
    const displayNameOpt = options.find(opt => opt.name === 'display_name') as APIApplicationCommandInteractionDataStringOption | undefined;
    const lastfmOpt = options.find(opt => opt.name === 'lastfm_username') as APIApplicationCommandInteractionDataStringOption | undefined;
    const rymOpt = options.find(opt => opt.name === 'rym_username') as APIApplicationCommandInteractionDataStringOption | undefined;

    const displayName = displayNameOpt?.value || interaction.member!.user.username; // fallback to discord name
    const lastfmUsername = lastfmOpt?.value || null;
    const rymUsername = rymOpt?.value || null;

    try {
        // Upsert the user into the database
        await db.execute({
            sql: `
                INSERT INTO users (userDiscordId, userDisplayName, userLastFMUserName, userRYMUserName, createdAt)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(userDiscordId) DO UPDATE SET
                    userDisplayName = excluded.userDisplayName,
                    userLastFMUserName = COALESCE(excluded.userLastFMUserName, users.userLastFMUserName),
                    userRYMUserName = COALESCE(excluded.userRYMUserName, users.userRYMUserName),
                    ModifiedAt = CURRENT_TIMESTAMP;
            `,
            args: [discordUserId, displayName, lastfmUsername, rymUsername]
        });

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { 
                content: `🍷 Welcome to ZORPHEUS 🩸🦇, **${displayName}**! Your profile has been created/updated.\n` +
                         (lastfmUsername ? `- Last.fm: \`${lastfmUsername}\`\n` : '') +
                         (rymUsername ? `- RYM: \`${rymUsername}\`` : '')
            },
        });
    } catch (error) {
        console.error("Database error in /join:", error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ There was an error saving your profile to the database." },
        });
    }
}