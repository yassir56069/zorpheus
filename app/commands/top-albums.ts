/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import { getTopAlbums, getDonorAlbums, MIN_RATINGS_TO_RANK } from '@/utils/database/album-service';
import { mapLastFmTagToGenre } from '@/utils/database/genre-service';

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
    
    // --- NEW: Extract and parse Genre Option ---
    const rawGenre = (options.find(opt => opt.name === 'genre') as any)?.value;

    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    let genreToQuery: string | undefined;
    let displayGenre = '';

    if (rawGenre) {
        const mappedGenre = mapLastFmTagToGenre(rawGenre);
        if (!mappedGenre) {
            // If the genre is invalid, immediately update the response safely in the background
            waitUntil(editInteractionResponse(interaction.token, { 
                content: `⚠️ I couldn't map \`${rawGenre}\` to a valid database genre. Please try a different genre.` 
            }));
            return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
        }
        genreToQuery = mappedGenre;
        
        // Formats "post-punk" -> "Post-Punk" / "hip hop" -> "Hip Hop" for the embed title
        displayGenre = mappedGenre
            .split(' ')
            .map((w: string) => w.split('-').map((x: string) => x.charAt(0).toUpperCase() + x.slice(1)).join('-'))
            .join(' ');
    }

    const runBackgroundTask = async () => {
        try {
            const limit = 20; 
            // Pass the genre to your database query
            const albums = await getTopAlbums({ page, limit, days, genre: genreToQuery });

            if (!albums || albums.length === 0) {
                const genreText = displayGenre ? `**${displayGenre}** ` : '';
                await editInteractionResponse(interaction.token, { 
                    content: `❌ No rated ${genreText}albums found on page ${page}.` 
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

            // Dynamically build the title
            const baseTitle = displayGenre ? `Top Rated ${displayGenre} Albums` : `Top Rated Albums`;
            const title = period ? `${baseTitle} (Last ${period})` : `${baseTitle} (All Time)`;

            // Dynamically show the actual required ratings in the footer
            const minRatings = genreToQuery ? 3 : MIN_RATINGS_TO_RANK;

            await editInteractionResponse(interaction.token, {
                content: "",
                embeds:[{
                    title: `🏆 ${title}`,
                    description: list,
                    color: 0x2f3136, 
                    footer: { text: `Page ${page} • Minimum ${minRatings} ratings required` }
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
    const period = (options.find(opt => opt.name === 'period') as any)?.value;
    
    // --- NEW: Extract and parse Genre Option ---
    const rawGenre = (options.find(opt => opt.name === 'genre') as any)?.value;

    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    let genreToQuery: string | undefined;
    let displayGenre = '';

    if (rawGenre) {
        const mappedGenre = mapLastFmTagToGenre(rawGenre);
        if (!mappedGenre) {
            waitUntil(editInteractionResponse(interaction.token, { 
                content: `⚠️ I couldn't map \`${rawGenre}\` to a valid database genre. Please try a different genre.` 
            }));
            return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
        }
        genreToQuery = mappedGenre;
        
        displayGenre = mappedGenre
            .split(' ')
            .map((w: string) => w.split('-').map((x: string) => x.charAt(0).toUpperCase() + x.slice(1)).join('-'))
            .join(' ');
    }

    const runBackgroundTask = async () => {
        try {
            const limit = 20; 
            // Pass the genre to your database query
            const albums = await getDonorAlbums({ page, limit, days, genre: genreToQuery });

            if (!albums || albums.length === 0) {
                const genreText = displayGenre ? `**${displayGenre}** ` : '';
                await editInteractionResponse(interaction.token, { 
                    content: `❌ No ${genreText}donor albums found on page ${page}.` 
                });
                return;
            }

            // Dynamically set the goal post based on whether it's a genre chart
            const minRatingsTarget = genreToQuery ? 3 : MIN_RATINGS_TO_RANK;

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const list = albums.map((a: { weightedScore: any; artistName: string; name: string; ratingCount: number; }, i: any) => {
                const score = Number(a.weightedScore).toFixed(2);
                const artist = a.artistName.substring(0, 40);
                const name = a.name.substring(0, 40);
                
                // Calculate missing ratings based on the dynamic target
                const needed = minRatingsTarget - a.ratingCount;
                
                return `**${artist}** - *${name}* • **${score}** ★ \`(${a.ratingCount}/${minRatingsTarget})\` *(Needs ${needed} more!)*`;
            }).join('\n');

            const baseTitle = displayGenre ? `${displayGenre} Chart Pushers` : `Chart Pushers`;
            const title = period ? `${baseTitle} (Last ${period})` : `${baseTitle} (All Time)`;

            await editInteractionResponse(interaction.token, {
                content: "Looking for something to listen to? These albums are just a few ratings away from charting! 👀",
                embeds:[{
                    title: `📈 ${title}`,
                    description: list,
                    color: 0xe67e22, // Orange theme for action required
                    footer: { text: `Page ${page} • Needs ${minRatingsTarget} ratings to hit the main chart` }
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