// app/api/interactions/route.ts
import { NextResponse } from 'next/server';
import {
    InteractionType,
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIMessageComponentButtonInteraction,
    APIMessageComponentSelectMenuInteraction,
    APIMessageComponentInteraction,
    ComponentType,
} from 'discord-api-types/v10';
import { verifyDiscordRequest } from '@/utils/verify-discord-request';

// Import command handlers
import { handlePing } from '@/app/commands/ping';
import { handleRate } from '@/app/commands/rate';
import { handleImport } from '@/app/commands/import';
import { handleAlbum, handleAlbumSearch, renderAlbumEmbed, editInteractionResponse, handleCanonizeAlbum, handleCanonizeAlbumById } from '@/app/commands/album';
import { handleCover, handleCoverButtonInteraction } from '@/app/commands/cover';
import { handleFm, handleFmResync, handleFmLove } from '@/app/commands/fm';
import { handleCountdown, handleCountdownInteraction  } from '@/app/commands/countdown';
import { handleProfile, handleProfileButtonInteraction } from '@/app/commands/profile';
import { handleChart, handleServerChart } from '@/app/commands/chart';
import { handleRc } from '@/app/commands/rc';
import { handleLeague } from '@/app/commands/league';
import { handleJoin } from '@/app/commands/join';
import { handleDev } from '@/app/sandbox/dev';
import {
    handleFeaturedAlbum,
    handleFeatureQueueList,
    handleFeaturePoints,
    handleFeatureTick,
} from '@/app/commands/feature';
import { enqueueAlbumForFeature } from '@/utils/database/feature-service';

// database
import { upsertRating } from '@/utils/database/ratings-service';
import { getOrCreateAlbum } from '@/utils/database/album-service';
import { waitUntil } from '@vercel/functions';
import { handleDonorAlbums, handleListUnrated, handleTopAlbums } from '@/app/commands/top-albums';
import { handleTopChart,handleUnratedTopChart } from '@/app/commands/top-chart';
import { handleAssignGenre, handleAssignGenreSelect } from '@/app/commands/assign-genre';
import { handleRemoveGenre, handleRemoveGenreSelect } from '@/app/commands/remove-genre';
import { handleAlbumHighlight } from '@/app/commands/aotd';
import { handleArtistSearch, renderArtistEmbed } from '@/app/commands/artists';
import { getAlbumById } from '@/utils/database/album-service';
import { handleUserRatingsSearch } from '@/app/commands/user-ratings';
import { handleBan } from '@/app/commands/ban';
import { handleInvalidateCache } from '@/app/commands/invalidate-cache';
import { handleGiveFeaturePoints } from '@/app/commands/give-feature-points';

const BANNED_GUILD_ID = '1478001076556009537'; // heehee

export async function POST(req: Request) {

    //#region  Validations
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
                content: "🛑🦇**ZORPHEUS has been decommissioned from SOUND AND VISIONE and will no longer respond to commands here.. LONG! LIVE! GOONDOLIN!** 🛑🦇 \n-# If you're reasing n-# Sincerely, the Zorpheus Lifeblood 🩸🩸",
                flags: 64,
            },
        });
    }
    //#endregion

    //#region  Commands
    if (interaction.type === InteractionType.ApplicationCommand) {
        const { name } = interaction.data;

        switch (name) {
            case 'ban':
                return handleBan(interaction as APIChatInputApplicationCommandInteraction);
            case 'ping':
                return handlePing(interaction as APIChatInputApplicationCommandInteraction);
            case 'rate':
                return handleRate(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'import':
                return handleImport(interaction as APIChatInputApplicationCommandInteraction);
            case 'assign-genre':
                return handleAssignGenre(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'remove-genre':
                return handleRemoveGenre(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'canonize-album':
                return handleCanonizeAlbum(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'canonize-album-id':
                return handleCanonizeAlbumById(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'aotd':
                return handleAlbumHighlight(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            //#region Featured Album
            case 'featured-album':
                return handleFeaturedAlbum(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'feature-queue':
                return handleFeatureQueueList(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'feature-points':
                return handleFeaturePoints(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'feature-tick':
                return handleFeatureTick(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'give-feature-points':
                return handleGiveFeaturePoints(interaction as APIChatInputApplicationCommandInteraction);
            //#endregion
            case 'album':
                return handleAlbum(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'album-search':
                return handleAlbumSearch(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'artist-search':
                return handleArtistSearch(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'user-ratings':
                return handleUserRatingsSearch(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'list-unrated': 
                return handleListUnrated(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'top-albums':
                return handleTopAlbums(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'donor-albums':
                return handleDonorAlbums(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'top-chart':
                return handleTopChart(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'top-unrated':
                return handleUnratedTopChart(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'join':
                return handleJoin(interaction as APIChatInputApplicationCommandInteraction);
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
            case 'serverchart':
                return await handleServerChart(interaction as APIChatInputApplicationCommandInteraction);
            case 'league':
                return handleLeague(interaction as APIChatInputApplicationCommandInteraction);
            case 'rc':
                return handleRc(interaction as APIChatInputApplicationCommandInteraction);
            case 'invalidate-cache':
                return handleInvalidateCache(interaction as APIChatInputApplicationCommandInteraction);
            case 'dev':
                return handleDev(interaction as APIChatInputApplicationCommandInteraction);

            default:
                return new NextResponse('Unknown command', { status: 400 });
        }
    }
    //#endregion

    //#region  Interactions
    if (interaction.type === InteractionType.MessageComponent) {
        const componentInteraction = interaction as APIMessageComponentInteraction;
        const customId = componentInteraction.data.custom_id;

        //#region Menus
        if (componentInteraction.data.component_type === ComponentType.StringSelect) {
            const selectInteraction = componentInteraction as APIMessageComponentSelectMenuInteraction;

            //#region Assign Genre
            if (customId.startsWith('assign_genre_select_')) {
                return await handleAssignGenreSelect(selectInteraction, waitUntil);
            }
            //#endregion

            //#region Remove Genre
            if (customId.startsWith('remove_genre_select_')) {
                return await handleRemoveGenreSelect(selectInteraction, waitUntil);
            }
            //#endregion

            //#region Rating (Standard /rate command)
            if (customId.startsWith('rate_select_')) {
                const userIdFromId = customId.replace('rate_select_', '');
                const actingUserId = selectInteraction.member?.user.id || selectInteraction.user?.id;

                if (actingUserId !== userIdFromId) {
                    return NextResponse.json({
                        type: InteractionResponseType.ChannelMessageWithSource,
                        data: { content: "This menu isn't for you!", flags: 64 }
                    });
                }

                const score = parseInt(selectInteraction.data.values[0]);
                const embed = selectInteraction.message.embeds[0];
                const description = embed.description || "";
                const [artistName, albumName] = description.split(' - ').map(s => s.replace(/[\*\?]/g, '').trim());

                const album = await getOrCreateAlbum({ name: albumName, artistName, userId: actingUserId! });
                await upsertRating(actingUserId!, album!.slug as string, score);

                return NextResponse.json({
                    type: InteractionResponseType.UpdateMessage,
                    data: {
                        content: `✅ Successfully rated **${albumName}** by **${artistName}**: **${score / 2}** stars.`,
                        embeds: [],
                        components: []
                    }
                });
            }
            //#endregion

            //#region Rating from Embed (/album & /album-search)
            if (customId === 'rate_album_embed') {
                const actingUserId = selectInteraction.member?.user.id || selectInteraction.user?.id;
                const score = parseInt(selectInteraction.data.values[0]);

                if (!actingUserId) {
                    return NextResponse.json({
                        type: InteractionResponseType.ChannelMessageWithSource,
                        data: { content: "Unauthorized", flags: 64 }
                    });
                }

                const embed = selectInteraction.message.embeds[0];
                const footerText = embed?.footer?.text;
                const slugMatch = footerText?.match(/Slug: (.+)/);
                const slug = slugMatch ? slugMatch[1] : null;

                if (!slug) {
                    return NextResponse.json({
                        type: InteractionResponseType.ChannelMessageWithSource,
                        data: { content: "❌ Could not determine album from embed.", flags: 64 }
                    });
                }

                waitUntil((async () => {
                    try {
                        await upsertRating(actingUserId, slug, score);

                        const result = await renderAlbumEmbed(slug);
                        await editInteractionResponse(interaction.token, {
                            ...result.data
                        });
                    } catch (error) {
                        console.error("[ALBUM] Background embed update error:", error);
                    }
                })());

                return NextResponse.json({
                    type: InteractionResponseType.DeferredMessageUpdate
                });
            }
            //#endregion

            //#region Album Search
            if (customId === 'album_search_select') {
                const selectedSlug = componentInteraction.data.values[0];

                waitUntil((async () => {
                    try {
                        const result = await renderAlbumEmbed(selectedSlug);
                        await editInteractionResponse(interaction.token, {
                            content: "",
                            ...result.data
                        });
                    } catch (error) {
                        console.error("[ALBUM] Select Menu Background Error:", error);
                        await editInteractionResponse(interaction.token, {
                            content: `❌ An internal error occurred while retrieving the album.`,
                            embeds: [],
                            components: []
                        });
                    }
                })());

                return NextResponse.json({
                    type: InteractionResponseType.UpdateMessage,
                    data: {
                        content: `⏳ Fetching statistics and cover art for \`${selectedSlug}\`. This might take a moment...`,
                        embeds: [],
                        components: []
                    }
                });
            }
            //#endregion

            //#region Artist Search
            if (customId === 'artist_search_select') {
                const selectedArtist = componentInteraction.data.values[0];

                waitUntil((async () => {
                    try {
                        const result = await renderArtistEmbed(selectedArtist);
                        await editInteractionResponse(interaction.token, {
                            content: "",
                            ...result.data
                        });
                    } catch (error) {
                        console.error("[ARTIST] Select Menu Background Error:", error);
                        await editInteractionResponse(interaction.token, {
                            content: `❌ Could not load discography.`
                        });
                    }
                })());

                return NextResponse.json({
                    type: InteractionResponseType.UpdateMessage,
                    data: {
                        content: `⏳ Loading discography for **${selectedArtist}**...`,
                        embeds: [],
                        components: []
                    }
                });
            }
            //#endregion
        }
        //#endregion

        //#region Buttons
        if (componentInteraction.data.component_type === ComponentType.Button) {
            const buttonInteraction = componentInteraction as APIMessageComponentButtonInteraction;

            //#region Love FM
            if (customId.startsWith('love_fm_')) {
                return handleFmLove(buttonInteraction);
            }
            //#endregion

            //#region Profile Pagination
            if (customId.startsWith('profile_')) {
                return handleProfileButtonInteraction(buttonInteraction);
            }
            //#endregion

            //#region Resync
            if (customId.startsWith('resync_fm_')) {
                return handleFmResync(buttonInteraction);
            }
            //#endregion

            //#region Cover
            if (customId.startsWith('cov_')) {
                return handleCoverButtonInteraction(buttonInteraction);
            }
            //#endregion

            //#region Counter
            if (customId.startsWith('countdown_')) {
                return handleCountdownInteraction(buttonInteraction);
            }
            //#endregion

            //#region Feature Nominate Button (From Album Embed)
            if (customId.startsWith('feature_nominate:')) {
                const albumSlug = customId.split(':')[1];
                const userId = buttonInteraction.member?.user.id || buttonInteraction.user?.id;

                if (!userId) {
                    return NextResponse.json({
                        type: InteractionResponseType.ChannelMessageWithSource,
                        data: { content: '❌ Could not identify your user.', flags: 64 }
                    });
                }

                waitUntil((async () => {
                    try {
                        const result = await enqueueAlbumForFeature(userId, albumSlug);

                        if (!result.success) {
                            await editInteractionResponse(interaction.token, {
                                content: `❌ Could not nominate album: ${result.reason}`
                            });
                            return;
                        }

                        const startTs = Math.floor(
                            new Date(result.startDate! + 'T00:00:00.000Z').getTime() / 1000
                        );

                        await editInteractionResponse(interaction.token, {
                            content: `⭐ **\`${albumSlug}\`** has been added to the feature queue! It will be featured starting <t:${startTs}:D>.`
                        });
                    } catch (error) {
                        console.error('[FEATURE] Nominate button error:', error);
                        await editInteractionResponse(interaction.token, {
                            content: '❌ An error occurred while nominating the album.'
                        });
                    }
                })());

                return NextResponse.json({ type: InteractionResponseType.DeferredMessageUpdate });
            }
            //#endregion

            //#region View Artist Button (From Album Embed)
            if (customId.startsWith('view_artist:')) {
                const albumId = parseInt(customId.split(':')[1], 10);

                waitUntil((async () => {
                    try {
                        const album = await getAlbumById(albumId);

                        if (!album) {
                            await editInteractionResponse(interaction.token, {
                                content: `❌ Could not find the original album to retrieve the artist.`
                            });
                            return;
                        }

                        const artistName = album.artistName as string;
                        console.log(`[ARTIST] Loading discography for: ${artistName} (from album ID ${albumId})`);

                        const result = await renderArtistEmbed(artistName);
                        await editInteractionResponse(interaction.token, {
                            content: "",
                            ...result.data
                        });
                    } catch (error) {
                        console.error("[ARTIST] Button Background Error:", error);
                        await editInteractionResponse(interaction.token, {
                            content: `❌ Could not load the discography.`
                        });
                    }
                })());

                return NextResponse.json({
                    type: InteractionResponseType.UpdateMessage,
                    data: {
                        content: `⏳ Loading discography, please wait ...`,
                        embeds: [],
                        components: []
                    }
                });
            }
            //#endregion
        }
        //#endregion

        return new NextResponse('Unhandled component interaction', { status: 400 });
    }
    //#endregion

    return new NextResponse('Unhandled interaction type', { status: 404 });
}