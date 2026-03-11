import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ComponentType,
    APIStringSelectComponent
} from 'discord-api-types/v10';
import { getAlbumById, getOrCreateAlbum } from '@/utils/database/album-service';
import { getUserLastFM } from '@/utils/database/user-service';
import { addManualAlbumGenre, VALID_GENRES } from '@/utils/database/genre-service';
import { editInteractionResponse } from './album';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

function titleCase(str: string): string {
    return str.replace(
        /\w\S*/g,
        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
}

/**
 * Handles the `/assign-genre` slash command.
 */
export async function handleAssignGenre(
    interaction: APIChatInputApplicationCommandInteraction, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitUntil: (promise: Promise<any>) => void
) {
    console.log("[GENRE] Received /assign-genre command");
    const options = interaction.data.options ??[];
    
    // Note: Ensure your slash command option in Discord is named 'album-id'
    const albumIdOption = options.find(opt => opt.name === 'album-id') as APIApplicationCommandInteractionDataStringOption | undefined;
    
    const discordUserId = interaction.member?.user?.id || interaction.user?.id;

    const runBackgroundTask = async () => {
        try {
            let targetAlbumId: number | undefined = albumIdOption ? Number(albumIdOption.value) : undefined;
            let targetAlbumName = "";
            let targetAlbumArtist = "";

            // If no ID is provided, attempt to fetch the user's current Last.fm track
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
                // Fetch existing album directly by ID
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

            // Split VALID_GENRES into two menus to bypass Discord's 25-item dropdown limit
            const sortedGenres = [...VALID_GENRES].sort();
            
            // Pass the album ID back in the `value` payload so the Select event remembers the album context
            const firstHalf = sortedGenres.slice(0, 25).map(g => ({
                label: titleCase(g),
                value: `${targetAlbumId}::${g}` 
            }));
            
            const secondHalf = sortedGenres.slice(25).map(g => ({
                label: titleCase(g),
                value: `${targetAlbumId}::${g}`
            }));

            // Build the components array
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const components: any[] =[
                {
                    type: ComponentType.ActionRow,
                    components:[{
                        type: ComponentType.StringSelect,
                        custom_id: `assign_genre_select_1`,
                        placeholder: "Select a genre (A-R)",
                        options: firstHalf
                    }]
                }
            ];

            // Add the second dropdown if we have more than 25 genres
            if (secondHalf.length > 0) {
                components.push({
                    type: ComponentType.ActionRow,
                    components:[{
                        type: ComponentType.StringSelect,
                        custom_id: `assign_genre_select_2`,
                        placeholder: "Select a genre (R-Z)",
                        options: secondHalf
                    }]
                });
            }

            await editInteractionResponse(interaction.token, {
                content: `🏷️ **Assign a genre** to **${targetAlbumName}** by **${targetAlbumArtist}**:\nChoose a genre from the dropdowns below.`,
                components
            });

        } catch (error) {
            console.error(`[GENRE] FATAL error in assign-genre task:`, error);
            await editInteractionResponse(interaction.token, { 
                content: `❌ An internal error occurred while assigning the genre.` 
            });
        }
    };

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

/**
 * Handles the interaction when a user clicks an option in the Assign Genre dropdown.
 * Route any custom_ids starting with `assign_genre_select_` to this function in your main API route.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleAssignGenreSelect(interaction: any, waitUntil: (promise: Promise<any>) => void) {
    const selectedValue = interaction.data.values[0]; // Resolves to e.g. "1234::experimental"
    const [albumIdStr, genre] = selectedValue.split('::');
    const discordUserId = interaction.member?.user?.id || interaction.user?.id;

    const runBackgroundTask = async () => {
        try {
            const success = await addManualAlbumGenre(Number(albumIdStr), genre, discordUserId);
            
            if (success) {
                await editInteractionResponse(interaction.token, {
                    content: `✅ Successfully tagged the album with \`${titleCase(genre)}\`!`,
                    components:[] 
                });
            } else {
                await editInteractionResponse(interaction.token, {
                    content: `❌ Could not find the album to tag in the database.`,
                    components:[] 
                });
            }
        } catch (error) {
            console.error(`[GENRE] error assigning genre:`, error);
            await editInteractionResponse(interaction.token, {
                content: `❌ Failed to assign genre. It may already be attached to this album.`,
                components:[] 
            });
        }
    };

    waitUntil(runBackgroundTask());
    // Use DeferredMessageUpdate instead of DeferredChannelMessageWithSource for components!
    return NextResponse.json({ type: InteractionResponseType.DeferredMessageUpdate });
}
