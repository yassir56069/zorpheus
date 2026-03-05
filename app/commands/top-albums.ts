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
 * Helper to update the deferred interaction message.
 * This is required for serverless functions that take longer than 3 seconds.
 */
async function editInteractionResponse(token: string, data: any) {
    if (!APP_ID) {
        console.error("[TOP-ALBUMS] ERROR: Missing DISCORD_APPLICATION_ID");
        return;
    }

    const url = `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`;
    
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`[TOP-ALBUMS] Discord Webhook Update Failed: ${res.status}`, errorText);
    }
}

export async function handleTopAlbums(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    const options = interaction.data.options ?? [];
    
    // Explicitly cast and parse to Number to satisfy TypeScript arithmetic requirements
    const pageOption = options.find(opt => opt.name === 'page') as APIApplicationCommandInteractionDataNumberOption | undefined;
    const page: number = pageOption ? Number(pageOption.value) : 1;

    const periodOption = options.find(opt => opt.name === 'period') as APIApplicationCommandInteractionDataStringOption | undefined;
    const period = periodOption?.value;

    // Map period string to days
    const daysMap: Record<string, number> = {
        'week': 7,
        'month': 30,
        'year': 365
    };
    const days = period ? daysMap[period] : undefined;

    const runBackgroundTask = async () => {
        try {
            const limit = 10;
            const albums = await getTopAlbums({ page, limit, days });

            if (!albums || albums.length === 0) {
                await editInteractionResponse(interaction.token, { 
                    content: page > 1 
                        ? `❌ No more albums found on page **${page}**.` 
                        : "❌ No ratings found for this period." 
                });
                return;
            }

            // Format the list using the number types confirmed above
            const list = albums.map((a, i) => {
                const globalIndex = (page - 1) * limit + (i + 1);
                const score = a.avgScore ? (Number(a.avgScore) / 2).toFixed(2) : '0.00';
                
                // Using Markdown for a clean textual list
                const starLine = `**${globalIndex}.** ${a.artistName} - **${a.name}**`;
                const statsLine = `> \`${score}/5\` (${a.ratingCount} ratings) — \`${a.slug}\``;
                return `${starLine}\n${statsLine}`;
            }).join('\n\n');

            const title = period ? `Top Albums of the ${period.charAt(0).toUpperCase() + period.slice(1)}` : `Top Rated Albums (All Time)`;

            await editInteractionResponse(interaction.token, {
                embeds: [{
                    title: `🏆 ${title}`,
                    description: list,
                    footer: { 
                        text: `Page ${page} • Use /top-albums page:${page + 1} to see more` 
                    },
                    color: 0xf1c40f // Gold
                }]
            });
        } catch (error) {
            console.error("[TOP-ALBUMS] Error in background task:", error);
            await editInteractionResponse(interaction.token, { 
                content: "❌ An error occurred while fetching the leaderboard." 
            });
        }
    };

    // Use waitUntil for Vercel/Serverless environments to keep the function alive
    waitUntil(runBackgroundTask());

    // Immediately respond with a "Thinking..." state
    return NextResponse.json({ 
        type: InteractionResponseType.DeferredChannelMessageWithSource 
    });
}