// app/commands/remove-genre.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ComponentType
} from 'discord-api-types/v10';
import { getAlbumById, getOrCreateAlbum } from '@/utils/database/album-service';
import { getUserLastFM } from '@/utils/database/user-service';
import { removeAlbumGenre, VALID_GENRES } from '@/utils/database/genre-service';
import { editInteractionResponse } from './album';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

function titleCase(str: string): string {
    return str.replace(
        /\w\S*/g,
        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
}

/**
 * Handles the `/remove-genre` slash command.
 */
export async function handleRemoveGenre(
    interaction: APIChatInputApplicationCommandInteraction, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitUntil: (promise: Promise<any>) => void
) {
    console.log("[GENRE] Received /remove-genre command");
    const options = interaction.data.options ?? [];
    
    const albumIdOption = options.find(opt => opt.name === 'album-id') as APIApplicationCommandInteractionDataStringOption | undefined;
    
    const discordUserId = interaction.member?.user?.id || interaction.user?.id;

    const runBackgroundTask = async () => {
        try {
            let targetAlbumId: number | undefined = albumIdOption ? Number(albumIdOption.value) : undefined;
            let targetAlbumName = "";
            let targetAlbumArtist = "";

            // Fallback to currently playing Last.FM track if no ID is provided
            if (!targetAlbumId || isNaN(targetAlbumId)) {
                const lastfmUsername = await getUserLastFM(discordUserId as string) as string | null;
                
                if (!lastfmUsername) {
                    await editInteractionResponse(interaction.token, {
                        content: `You haven't registered your Last.fm username yet! Provide an album ID directly.`
                    });
                    return;
                }

                const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsername}&api_key=${LASTFM_API_KEY}&format=json&limit=1`;
                const response = await fetch(apiUrl);
                const data = await response.json();

                if (data.error || !data.recenttracks || data.recenttracks.track.length === 0) {
                    await editInteractionResponse(interaction.token, {
                        content: `Could not find any recent tracks for user \`${lastfmUsername}\`.`
                    });
                    return;
                }

                const track = data.recenttracks.track[0];
                const artist = track.artist['#text'];
                const albumName = track.album['#text'];
                const albumMbid = track.album.mbid || null;

                if (!albumName) {
                    await editInteractionResponse(interaction.token, {
                        content: `Your current track doesn't have an album associated with it. Please provide an album ID directly.`
                    });
                    return;
                }

                const albumRecord = await getOrCreateAlbum({
                    name: albumName,
                    artistName: artist,
                    mbid: albumMbid,
                    userId: discordUserId as string
                });

                if (!albumRecord) {
                    await editInteractionResponse(interaction.token, { content: `❌ Failed to process the album.` });
                    return;
                }

                targetAlbumId = albumRecord.id as number;
                targetAlbumName = albumRecord.name as string;
                targetAlbumArtist = albumRecord.artistName as string;
            } else {
                const albumRecord = await getAlbumById(targetAlbumId);
                
                if (!albumRecord) {
                    await editInteractionResponse(interaction.token, { 
                        content: `❌ Could not find an album with ID \`${targetAlbumId}\`.` 
                    });
                    return;
                }
                targetAlbumName = albumRecord.name as string;
                targetAlbumArtist = albumRecord.artistName as string;
            }

            // Split VALID_GENRES into menus to bypass Discord's 25-item dropdown limit
            const sortedGenres = [...VALID_GENRES].sort();
            
            const firstHalf = sortedGenres.slice(0, 25).map(g => ({
                label: titleCase(g),
                value: `${targetAlbumId}::${g}` 
            }));
            
            const secondHalf = sortedGenres.slice(25).map(g => ({
                label: titleCase(g),
                value: `${targetAlbumId}::${g}`
            }));

            const firstStartLetter = firstHalf[0].label.charAt(0).toUpperCase();
            const firstEndLetter = firstHalf[firstHalf.length - 1].label.charAt(0).toUpperCase();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const components: any[] = [
                {
                    type: ComponentType.ActionRow,
                    components: [{
                        type: ComponentType.StringSelect,
                        custom_id: `remove_genre_select_1`,
                        placeholder: `Select a genre to remove (${firstStartLetter}-${firstEndLetter})`,
                        options: firstHalf
                    }]
                }
            ];

            if (secondHalf.length > 0) {
                const secondStartLetter = secondHalf[0].label.charAt(0).toUpperCase();
                const secondEndLetter = secondHalf[secondHalf.length - 1].label.charAt(0).toUpperCase();

                components.push({
                    type: ComponentType.ActionRow,
                    components: [{
                        type: ComponentType.StringSelect,
                        custom_id: `remove_genre_select_2`,
                        placeholder: `Select a genre to remove (${secondStartLetter}-${secondEndLetter})`,
                        options: secondHalf
                    }]
                });
            }

            await editInteractionResponse(interaction.token, {
                content: `🗑️ **Remove a genre** from **${targetAlbumName}** by **${targetAlbumArtist}**:\nChoose a genre from the dropdowns below.`,
                components
            });

        } catch (error) {
            console.error(`[GENRE] FATAL error in remove-genre task:`, error);
            await editInteractionResponse(interaction.token, { 
                content: `❌ An internal error occurred while fetching the album.` 
            });
        }
    };

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

/**
 * Handles the interaction when a user clicks an option in the Remove Genre dropdown.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleRemoveGenreSelect(interaction: any, waitUntil: (promise: Promise<any>) => void) {
    const selectedValue = interaction.data.values[0]; 
    const [albumIdStr, genre] = selectedValue.split('::');

    const runBackgroundTask = async () => {
        try {
            const success = await removeAlbumGenre(Number(albumIdStr), genre);
            
            if (success) {
                await editInteractionResponse(interaction.token, {
                    content: `✅ Successfully removed the tag \`${titleCase(genre)}\` from the album!`,
                    components: [] 
                });
            } else {
                await editInteractionResponse(interaction.token, {
                    content: `❌ Could not remove the genre. It may not be attached to this album.`,
                    components: [] 
                });
            }
        } catch (error) {
            console.error(`[GENRE] error removing genre:`, error);
            await editInteractionResponse(interaction.token, {
                content: `❌ Failed to remove genre due to a database error.`,
                components: [] 
            });
        }
    };

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredMessageUpdate });
}