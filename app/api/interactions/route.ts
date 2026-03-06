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
import { handleAlbum, handleAlbumSearch, renderAlbumEmbed, editInteractionResponse } from '@/app/commands/album';
import { handleCover, handleCoverButtonInteraction } from '@/app/commands/cover';
import { handleFm, handleFmResync } from '@/app/commands/fm'; 
import { handleCountdown, handleCountdownInteraction  } from '@/app/commands/countdown';
import { handleProfile, handleProfileButtonInteraction } from '@/app/commands/profile';
import { handleChart, handleServerChart } from '@/app/commands/chart';
import { handleRc } from '@/app/commands/rc';
import { handleLeague } from '@/app/commands/league';
import { handleJoin } from '@/app/commands/join';
import { handleDev } from '@/app/sandbox/dev';

// database
import { upsertRating } from '@/utils/database/ratings-service';
import { getOrCreateAlbum } from '@/utils/database/album-service';
import { waitUntil } from '@vercel/functions';
import { handleTopAlbums } from '@/app/commands/top-albums';

const BANNED_GUILD_ID = '1373961525890514964'; // heehee

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
                content: "🛑🦇**ZORPHEUS has been decommissioned from SOUND AND VISIONE and will no longer respond to commands here.. LONG! LIVE! GOONDOLIN!** 🛑🦇 \n-# If you're reading this, I'm working on ratings for the bot for a new server, dm me if you're interested ;;;)) Love you all <3\n-# Sincerely, the Zorpheus Lifeblood 🩸🩸",
                flags: 64,
            },
        });
    }    
    //#endregion

    //#region  Commands
    if (interaction.type === InteractionType.ApplicationCommand) {
        const { name } = interaction.data;

        switch (name) {
            case 'ping':
                return handlePing(interaction as APIChatInputApplicationCommandInteraction);
            case 'rate':
                return handleRate(interaction as APIChatInputApplicationCommandInteraction);
            case 'import': 
                return handleImport(interaction as APIChatInputApplicationCommandInteraction);
            case 'album':
                return handleAlbum(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'album-search':
                return handleAlbumSearch(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
            case 'top-albums':
                return handleTopAlbums(interaction as APIChatInputApplicationCommandInteraction, waitUntil);
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
    //#endregion

    //#region  Interactions
    if (interaction.type === InteractionType.MessageComponent) {
        const componentInteraction = interaction as APIMessageComponentInteraction;
        const customId = componentInteraction.data.custom_id;

        //#region Menus
        if (componentInteraction.data.component_type === ComponentType.StringSelect) {
            const selectInteraction = componentInteraction as APIMessageComponentSelectMenuInteraction;

            //#region Rating
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

            //#region Album Search
            if (customId === 'album_search_select') {
                const selectedSlug = componentInteraction.data.values[0];
                
                // Fire off the background task safely using waitUntil
                waitUntil((async () => {
                    try {
                        const result = await renderAlbumEmbed(selectedSlug);
                        
                        // Use the spread operator to append components safely 
                        // without mutating the strict TypeScript object
                        await editInteractionResponse(interaction.token, {
                            ...result.data,
                            components:[] // Explicitly clear components to remove the dropdown
                        });

                    } catch (error) {
                        console.error("[ALBUM] Select Menu Background Error:", error);
                        await editInteractionResponse(interaction.token, { 
                            content: `❌ An internal error occurred while retrieving the album.` 
                        });
                    }
                })());

                // Immediately acknowledge the selection so Discord never times out
                return NextResponse.json({
                    type: InteractionResponseType.DeferredMessageUpdate
                });
            }
        }
        //#endregion

        //#region Buttons
        if (componentInteraction.data.component_type === ComponentType.Button) {
            const buttonInteraction = componentInteraction as APIMessageComponentButtonInteraction;

        //#region Profile Pagination
        if (customId.startsWith('profile_')) {
            return handleProfileButtonInteraction(buttonInteraction);
        }
        //#endregion


        //#region  Resync
        if (customId.startsWith('resync_fm_')) {
            return handleFmResync(buttonInteraction);
        }
        //#endregion

        //#region Cover
        if (customId.startsWith('cov_')) {
            return handleCoverButtonInteraction(buttonInteraction);
        }
        //#endregion

        //#region  Counter
        if (customId.startsWith('countdown_')) { // Example prefix for your countdown buttons
            return handleCountdownInteraction(buttonInteraction);
        }
        //#endregion

        }
        //#endregion
        return new NextResponse('Unhandled component interaction', { status: 400 });
    }

    //#endregion

    return new NextResponse('Unhandled interaction type', { status: 404 });
}