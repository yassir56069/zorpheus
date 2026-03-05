/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import { getTopAlbums } from '@/utils/database/album-service';

const APP_ID = process.env.DISCORD_APPLICATION_ID;

async function editInteractionResponse(token: string, data: any) {
    if (!APP_ID) return;
    const url = `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`;
    await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
}

export async function handleTopAlbums(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    const options = interaction.data.options ?? [];
    const page = Number((options.find(opt => opt.name === 'page') as any)?.value || 1);
    const period = (options.find(opt => opt.name === 'period') as any)?.value;

    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    const runBackgroundTask = async () => {
        try {
            const limit = 20; // Increased limit
            const albums = await getTopAlbums({ page, limit, days });

            if (!albums || albums.length === 0) {
                await editInteractionResponse(interaction.token, { 
                    content: `❌ No results found on page ${page}.` 
                });
                return;
            }

            // Compact layout: 1. Artist - Album | 4.5/5 (12)
            const list = albums.map((a, i) => {
                const rank = (page - 1) * limit + (i + 1);
                const score = Number(a.weightedScore).toFixed(2);
                const artist = a.artistName.substring(0, 40);
                const name = a.name.substring(0, 40);
                
                return `**${rank}.** ${artist} - *${name}* • **${score}** ★ \`(${a.ratingCount})\``;
            }).join('\n');

            const title = period ? `Top Albums (Last ${period})` : `Top Rated Albums (All Time)`;

            await editInteractionResponse(interaction.token, {
                content: "",
                embeds: [{
                    title: `🏆 ${title}`,
                    description: list,
                    color: 0x2f3136, // Dark theme color
                    footer: { text: `Page ${page} • Weighted by total server members` }
                }]
            });
        } catch (error) {
            console.error(error);
            await editInteractionResponse(interaction.token, { content: "❌ Error fetching rankings." });
        }
    };

    waitUntil(runBackgroundTask());

    return NextResponse.json({ 
        type: InteractionResponseType.DeferredChannelMessageWithSource 
    });
}