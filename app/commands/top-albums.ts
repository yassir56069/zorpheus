/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import { getTopAlbums, getDonorAlbums, MIN_RATINGS_TO_RANK } from '@/utils/database/album-service';

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
    const options = interaction.data.options ??[];
    const page = Number((options.find(opt => opt.name === 'page') as any)?.value || 1);
    const period = (options.find(opt => opt.name === 'period') as any)?.value;

    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    const runBackgroundTask = async () => {
        try {
            const limit = 20; 
            const albums = await getTopAlbums({ page, limit, days });

            if (!albums || albums.length === 0) {
                await editInteractionResponse(interaction.token, { 
                    content: `❌ No results found on page ${page}.` 
                });
                return;
            }

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
                embeds:[{
                    title: `🏆 ${title}`,
                    description: list,
                    color: 0x2f3136, 
                    footer: { text: `Page ${page} • Minimum ${MIN_RATINGS_TO_RANK} ratings required` }
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

export async function handleDonorAlbums(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    const options = interaction.data.options ??[];
    const page = Number((options.find(opt => opt.name === 'page') as any)?.value || 1);
    
    // We can keep the period filtering if you want to support it!
    const period = (options.find(opt => opt.name === 'period') as any)?.value;
    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    const runBackgroundTask = async () => {
        try {
            const limit = 20; 
            const albums = await getDonorAlbums({ page, limit, days });

            if (!albums || albums.length === 0) {
                await editInteractionResponse(interaction.token, { 
                    content: `❌ No donor albums found on page ${page}.` 
                });
                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const list = albums.map((a: { weightedScore: any; artistName: string; name: string; ratingCount: number; }, i: any) => {
                const score = Number(a.weightedScore).toFixed(2);
                const artist = a.artistName.substring(0, 40);
                const name = a.name.substring(0, 40);
                const needed = MIN_RATINGS_TO_RANK - a.ratingCount;
                
                return `**${artist}** - *${name}* • **${score}** ★ \`(${a.ratingCount}/${MIN_RATINGS_TO_RANK})\` *(Needs ${needed} more!)*`;
            }).join('\n');

            const title = period ? `Chart Pushers (Last ${period})` : `Chart Pushers (All Time)`;

            await editInteractionResponse(interaction.token, {
                content: "Looking for something to listen to? These albums are just a few ratings away from charting! 👀",
                embeds:[{
                    title: `📈 ${title}`,
                    description: list,
                    color: 0xe67e22, // Orange theme for action required
                    footer: { text: `Page ${page} • Needs ${MIN_RATINGS_TO_RANK} ratings to hit the main chart` }
                }]
            });
        } catch (error) {
            console.error(error);
            await editInteractionResponse(interaction.token, { content: "❌ Error fetching donor albums." });
        }
    };

    waitUntil(runBackgroundTask());

    return NextResponse.json({ 
        type: InteractionResponseType.DeferredChannelMessageWithSource 
    });
}