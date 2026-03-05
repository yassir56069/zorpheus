/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataNumberOption,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { getTopAlbums } from '@/utils/database/album-service';

const APP_ID = process.env.DISCORD_APPLICATION_ID;

/**
 * Robust helper to update the interaction.
 */
async function editInteractionResponse(token: string, data: any) {
    if (!APP_ID) {
        console.error("[TOP-ALBUMS] ERROR: DISCORD_APPLICATION_ID is not set in environment.");
        return;
    }

    const url = `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`;
    
    try {
        const res = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`[TOP-ALBUMS] Discord API Error (${res.status}):`, errorText);
        }
    } catch (err) {
        console.error("[TOP-ALBUMS] Fetch Error:", err);
    }
}

export async function handleTopAlbums(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    const options = interaction.data.options ?? [];
    
    // 1. Safe parsing of options
    const pageOption = options.find(opt => opt.name === 'page') as APIApplicationCommandInteractionDataNumberOption | undefined;
    const page = pageOption ? Math.max(1, Number(pageOption.value)) : 1;

    const periodOption = options.find(opt => opt.name === 'period') as APIApplicationCommandInteractionDataStringOption | undefined;
    const period = periodOption?.value;

    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    // 2. Define the background process
    const runBackgroundTask = async () => {
        try {
            console.log(`[TOP-ALBUMS] Fetching page ${page} from DB...`);
            const limit = 10;
            const albums = await getTopAlbums({ page, limit, days });

            if (!albums || albums.length === 0) {
                await editInteractionResponse(interaction.token, { 
                    content: page > 1 
                        ? `❌ No more albums found on page **${page}**.` 
                        : "❌ No ratings found in the database yet." 
                });
                return;
            }

            // 3. Build the text list with character safety
            const list = albums.map((a, i) => {
                const globalIndex = (page - 1) * limit + (i + 1);
                // Handle Turso/SQLite returning avgScore as string or number
                const rawScore = a.avgScore ? Number(a.avgScore) : 0;
                const score = (rawScore / 2).toFixed(2);
                
                // Trim long names to prevent embed overflow (Discord limit is 4096 per description)
                const cleanArtist = a.artistName.substring(0, 50);
                const cleanAlbum = a.name.substring(0, 50);

                return `**${globalIndex}.** ${cleanArtist} - **${cleanAlbum}**\n` +
                       `> \`${score}/5\` (${a.ratingCount} ratings) — \`${a.slug}\``;
            }).join('\n\n');

            const title = period 
                ? `Top Albums: Last ${period.charAt(0).toUpperCase() + period.slice(1)}` 
                : `Top Rated Albums (All Time)`;

            // 4. Update the "Thinking..." message
            await editInteractionResponse(interaction.token, {
                content: "", // Clear the "Thinking" text if any
                embeds: [{
                    title: `🏆 ${title}`,
                    description: list.substring(0, 4000), // Safety check
                    footer: { 
                        text: `Page ${page} • Use "/top-albums page:${page + 1}" to see more` 
                    },
                    color: 0xf1c40f 
                }]
            });
            console.log(`[TOP-ALBUMS] Successfully sent page ${page}`);

        } catch (error) {
            console.error("[TOP-ALBUMS] Critical Background Error:", error);
            await editInteractionResponse(interaction.token, { 
                content: "❌ An internal error occurred while generating the leaderboard." 
            });
        }
    };

    // 5. Execution
    // We return the "Thinking..." state IMMEDIATELY to prevent 3s timeout
    const response = NextResponse.json({ 
        type: InteractionResponseType.DeferredChannelMessageWithSource 
    });

    // Ensure the background task runs in the serverless environment
    waitUntil(runBackgroundTask());

    return response;
}