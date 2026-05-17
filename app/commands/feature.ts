/* eslint-disable @typescript-eslint/no-unused-vars */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIEmbed
} from 'discord-api-types/v10';

import { getAlbumWithStats } from '@/utils/database/album-service';
import {
    getCurrentFeaturedAlbum,
    enqueueAlbumForFeature,
    getFeatureQueue,
    isAlbumFeatureEligible,
    getUserFeaturePoints,
    getFeatureLeaderboard,
    tickFeaturedAlbum,
    FEATURE_DURATION_DAYS
} from '@/utils/database/feature-service';
import { editInteractionResponse, renderAlbumEmbed } from './album';
import { fetchImageBuffer, isValidImageUrl, findCoverArt } from './rc';

const APP_ID = process.env.DISCORD_APPLICATION_ID;

// ---------------------------------------------------------------------------
// /featured-album  — show the currently live featured album
// ---------------------------------------------------------------------------

export async function handleFeaturedAlbum(
    interaction: APIChatInputApplicationCommandInteraction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitUntil: (promise: Promise<any>) => void
) {
    console.log('[FEATURED] Received /featured-album command');

    await fetch(
        `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
        {
            method: 'POST',
            body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
            headers: { 'Content-Type': 'application/json' },
        }
    );

    if (!APP_ID) {
        console.error('[FEATURED] Missing DISCORD_APPLICATION_ID');
        return new NextResponse(null, { status: 204 });
    }

    try {
        const featured = await getCurrentFeaturedAlbum();

        if (!featured) {
            await editInteractionResponse(interaction.token, {
                content: '📭 There is no featured album this week. Use `/feature-queue add` to nominate one!',
            });
            return new NextResponse(null, { status: 204 });
        }

        // Render the standard album embed
        const result = await renderAlbumEmbed(featured.albumSlug);
        const embedData = result.data;

        if (!embedData.embeds || embedData.embeds.length === 0) {
            await editInteractionResponse(interaction.token, {
                content: embedData.content || `❌ Failed to load the featured album.`,
            });
            return new NextResponse(null, { status: 204 });
        }

        const embed: APIEmbed = embedData.embeds[0];

        // Annotate embed with feature-specific details
        const endDate = new Date(featured.endDate + 'T00:00:00.000Z');
        const daysLeft = Math.max(
            0,
            Math.ceil((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        );

        embed.description = [
            embed.description,
            '',
            `🏆 **Feature Score:** ${featured.featureScore} pts  ·  **Ratings this week:** ${featured.ratingCount}`,
            `⏳ **${daysLeft} day${daysLeft !== 1 ? 's' : ''} left** (ends <t:${Math.floor(endDate.getTime() / 1000)}:D>)`,
            '',
            `_Rate this album this week to earn **+1 feature point**!_`,
        ]
            .filter(Boolean)
            .join('\n');

        embed.color = 0xf5a623; // warm gold to distinguish featured embeds

        const album = await getAlbumWithStats(featured.albumSlug);
        if (!album) throw new Error(`getAlbumWithStats failed for ${featured.albumSlug}`);

        let finalCoverUrl = album.coverArtUrl;
        if (!await isValidImageUrl(finalCoverUrl)) {
            finalCoverUrl = await findCoverArt(album.artistName, album.name);
        }

        if (finalCoverUrl) {
            finalCoverUrl = finalCoverUrl.replace(/\/\d+x\d+\//, '/1000x1000/');
            const imageBuffer = await fetchImageBuffer(finalCoverUrl);

            delete embed.thumbnail;
            embed.image = { url: 'attachment://cover.png' };

            const formData = new FormData();
            formData.append('file', new Blob([imageBuffer]), 'cover.png');
            formData.append(
                'payload_json',
                JSON.stringify({
                    content: `⭐ **Featured Album of the Week!** ⭐`,
                    embeds: [embed],
                    components: embedData.components,
                })
            );

            await fetch(
                `https://discord.com/api/v10/webhooks/${APP_ID}/${interaction.token}/messages/@original`,
                { method: 'PATCH', body: formData }
            );
        } else {
            await editInteractionResponse(interaction.token, {
                content: `⭐ **Featured Album of the Week!** ⭐\n*(Cover art unavailable.)*`,
                embeds: [embed],
                components: embedData.components,
            });
        }
    } catch (error) {
        console.error('[FEATURED] Error:', error);
        await editInteractionResponse(interaction.token, {
            content: '❌ An internal error occurred while fetching the featured album.',
        });
    }

    return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// /feature-queue add <album-slug>  — nominate an album
// ---------------------------------------------------------------------------

export async function handleFeatureQueueAdd(
    interaction: APIChatInputApplicationCommandInteraction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitUntil: (promise: Promise<any>) => void
) {
    console.log('[FEATURED] Received /feature-queue add command');

    await fetch(
        `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
        {
            method: 'POST',
            body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
            headers: { 'Content-Type': 'application/json' },
        }
    );

    if (!APP_ID) return new NextResponse(null, { status: 204 });

    // Extract the album slug option
    const options = (interaction.data as { options?: Array<{ name: string; value: unknown }> }).options ?? [];
    const slugOpt = options.find(o => o.name === 'album');
    const albumSlug = (slugOpt?.value as string | undefined)?.trim();

    if (!albumSlug) {
        await editInteractionResponse(interaction.token, {
            content: '❌ Please provide an album slug.',
        });
        return new NextResponse(null, { status: 204 });
    }

    const userId = interaction.member?.user?.id ?? (interaction as unknown as { user?: { id: string } }).user?.id ?? 'unknown';

    try {
        // Quick eligibility peek to give a clearer error before enqueue attempt
        const eligibility = await isAlbumFeatureEligible(albumSlug);

        if (!eligibility.eligible) {
            await editInteractionResponse(interaction.token, {
                content: `❌ **${albumSlug}** cannot be featured: ${eligibility.reason}`,
            });
            return new NextResponse(null, { status: 204 });
        }

        const result = await enqueueAlbumForFeature(userId, albumSlug);

        if (!result.success) {
            await editInteractionResponse(interaction.token, {
                content: `❌ Could not add album to the feature queue: ${result.reason}`,
            });
            return new NextResponse(null, { status: 204 });
        }

        const album = await getAlbumWithStats(albumSlug);
        const albumLabel = album ? `**${album.name}** by ${album.artistName}` : `\`${albumSlug}\``;

        const startTs = Math.floor(
            new Date(result.startDate! + 'T00:00:00.000Z').getTime() / 1000
        );

        await editInteractionResponse(interaction.token, {
            content: [
                `✅ ${albumLabel} has been added to the **feature queue**!`,
                `📅 It will be featured starting <t:${startTs}:D> for ${FEATURE_DURATION_DAYS} days.`,
                `_(Current ratings: ${eligibility.ratingCount}/${4} — one away from ranking!)_`,
            ].join('\n'),
        });
    } catch (error) {
        console.error('[FEATURED] handleFeatureQueueAdd error:', error);
        await editInteractionResponse(interaction.token, {
            content: '❌ An internal error occurred.',
        });
    }

    return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// /feature-queue list  — show the current queue
// ---------------------------------------------------------------------------

export async function handleFeatureQueueList(
    interaction: APIChatInputApplicationCommandInteraction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _waitUntil: (promise: Promise<any>) => void
) {
    console.log('[FEATURED] Received /feature-queue list command');

    await fetch(
        `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
        {
            method: 'POST',
            body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
            headers: { 'Content-Type': 'application/json' },
        }
    );

    if (!APP_ID) return new NextResponse(null, { status: 204 });

    try {
        const [featured, queue] = await Promise.all([
            getCurrentFeaturedAlbum(),
            getFeatureQueue(),
        ]);

        const lines: string[] = [];

        if (featured) {
            const endTs = Math.floor(
                new Date(featured.endDate + 'T00:00:00.000Z').getTime() / 1000
            );
            lines.push(`⭐ **Currently Featured** — \`${featured.albumSlug}\` (ends <t:${endTs}:D>)`);
            lines.push('');
        }

        if (queue.length === 0) {
            lines.push('📭 The feature queue is empty. Use `/feature-queue add` to nominate an album!');
        } else {
            lines.push('**📋 Feature Queue:**');
            for (let i = 0; i < queue.length; i++) {
                const entry = queue[i];
                const startTs = Math.floor(
                    new Date(entry.startDate + 'T00:00:00.000Z').getTime() / 1000
                );
                lines.push(`**${i + 1}.** \`${entry.albumSlug}\` — <t:${startTs}:D> (nominated by <@${entry.userId}>)`);
            }
        }

        await editInteractionResponse(interaction.token, {
            content: lines.join('\n'),
        });
    } catch (error) {
        console.error('[FEATURED] handleFeatureQueueList error:', error);
        await editInteractionResponse(interaction.token, {
            content: '❌ An internal error occurred while fetching the queue.',
        });
    }

    return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// /feature-points  — show a user's points (or the leaderboard)
// ---------------------------------------------------------------------------

export async function handleFeaturePoints(
    interaction: APIChatInputApplicationCommandInteraction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _waitUntil: (promise: Promise<any>) => void
) {
    console.log('[FEATURED] Received /feature-points command');

    await fetch(
        `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
        {
            method: 'POST',
            body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
            headers: { 'Content-Type': 'application/json' },
        }
    );

    if (!APP_ID) return new NextResponse(null, { status: 204 });

    try {
        const userId =
            interaction.member?.user?.id ??
            (interaction as unknown as { user?: { id: string } }).user?.id ??
            'unknown';

        const [userPoints, leaderboard] = await Promise.all([
            getUserFeaturePoints(userId),
            getFeatureLeaderboard(5),
        ]);

        const lbLines = leaderboard.map((entry, i) => {
            const medal = ['🥇', '🥈', '🥉'][i] ?? `**${i + 1}.**`;
            return `${medal} <@${entry.userId}> — **${entry.points} pt${entry.points !== 1 ? 's' : ''}**`;
        });

        const lines = [
            `🎯 You have **${userPoints} feature point${userPoints !== 1 ? 's' : ''}**.`,
            '',
            '**🏆 Top 5 Feature Contributors:**',
            ...lbLines,
            '',
            '_Earn points by rating the featured album during its active week._',
        ];

        await editInteractionResponse(interaction.token, {
            content: lines.join('\n'),
        });
    } catch (error) {
        console.error('[FEATURED] handleFeaturePoints error:', error);
        await editInteractionResponse(interaction.token, {
            content: '❌ An internal error occurred.',
        });
    }

    return new NextResponse(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Admin: /feature-tick  — manually trigger the weekly rotation (admin only)
// ---------------------------------------------------------------------------

export async function handleFeatureTick(
    interaction: APIChatInputApplicationCommandInteraction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _waitUntil: (promise: Promise<any>) => void
) {
    await fetch(
        `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
        {
            method: 'POST',
            body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
            headers: { 'Content-Type': 'application/json' },
        }
    );

    if (!APP_ID) return new NextResponse(null, { status: 204 });

    try {
        const { activated, expired } = await tickFeaturedAlbum();

        const parts: string[] = [];
        if (expired) parts.push(`📤 Expired: \`${expired}\` (isFeatured set to 2).`);
        if (activated) parts.push(`📥 Activated: \`${activated}\` is now the featured album!`);
        if (!expired && !activated) parts.push('ℹ️ Nothing to rotate right now.');

        await editInteractionResponse(interaction.token, {
            content: parts.join('\n'),
        });
    } catch (error) {
        console.error('[FEATURED] handleFeatureTick error:', error);
        await editInteractionResponse(interaction.token, {
            content: '❌ An internal error occurred during the tick.',
        });
    }

    return new NextResponse(null, { status: 204 });
}