import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    APIApplicationCommandInteractionDataUserOption,
    ComponentType,
} from 'discord-api-types/v10';
import { searchUserRatings, UserRatingSearchResult } from '@/utils/database/album-service';
import { getUserDisplayName } from '@/utils/database/user-service';
// Make sure to import your existing edit interaction utility
import { editInteractionResponse } from './album'; 

// Using your existing getStars function
function getStars(score: number): string {
    const fullStars = Math.floor(score / 2);
    const halfStar = score % 2 !== 0 ? '½' : '';
    const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
    return '★'.repeat(fullStars) + halfStar + '☆'.repeat(emptyStars);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleUserRatingsSearch(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    console.log("[USER-RATINGS] Received /user-ratings command");
    const options = interaction.data.options ??[];
    const queryOption = options.find(opt => opt.name === 'searchterm') as APIApplicationCommandInteractionDataStringOption | undefined;
    const userOption = options.find(opt => opt.name === 'user') as APIApplicationCommandInteractionDataUserOption | undefined;

    if (!queryOption) return new NextResponse('Missing query', { status: 400 });
    const searchTerm = queryOption.value;

    if (searchTerm.length > 100) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `❌ Search term is too long. Please keep it under 100 characters.` }
        });
    }

    // Resolve target user ID (Defaults to sender if not provided)
    const targetUserId = userOption ? userOption.value : (interaction.member?.user?.id || interaction.user?.id);
    if (!targetUserId) return new NextResponse('Missing user ID', { status: 400 });

    // Fallback username retrieval using discord interaction data
    let targetUserName = 'User';
    if (userOption && interaction.data.resolved?.users?.[targetUserId]) {
        targetUserName = interaction.data.resolved.users[targetUserId].username;
    } else if (!userOption) {
        targetUserName = interaction.member?.user?.username || interaction.user?.username || 'User';
    }

    const runBackgroundTask = async () => {
        try {
            // Attempt to fetch custom DB display name
            const dbName = await getUserDisplayName(targetUserId);
            const displayName = dbName || targetUserName;

            console.log(`[USER-RATINGS] Searching ratings for user ${targetUserId} with query: ${searchTerm}`);
            const ratedAlbums = await searchUserRatings(targetUserId, searchTerm);

            if (ratedAlbums.length === 0) {
                await editInteractionResponse(interaction.token, { 
                    content: `❌ Could not find any ratings by **${displayName}** matching \`${searchTerm}\`.` 
                });
                return;
            }

            const embedData = renderUserRatingsEmbed(ratedAlbums, displayName, searchTerm);
            await editInteractionResponse(interaction.token, embedData.data);

        } catch (error) {
            console.error("[USER-RATINGS] Search Background Error:", error);
            await editInteractionResponse(interaction.token, { content: "❌ An error occurred while searching user ratings." });
        }
    };

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

export function renderUserRatingsEmbed(albums: UserRatingSearchResult[], displayName: string, searchTerm: string) {
    const formatLine = (a: UserRatingSearchResult) => {
        const yearPrefix = `\`[${a.releaseYear || '????'}]\``;
        
        // Convert out-of-10 score to a /5 float string (e.g. 4.5)
        const rawScore = (Number(a.userScore) / 2).toFixed(1);
        const starInt = Math.round(Number(a.userScore));
        const starsDisplay = getStars(starInt);
        
        return `${yearPrefix} **${rawScore}** ${starsDisplay} : \`${a.artistName} - ${a.name}\``;
    };

    let description = "";

    for (const album of albums) {
        const line = formatLine(album) + "\n";
        
        if (description.length + line.length > 3900) {
            description += `*...and more (character limit reached)*\n`;
            break;
        }
        description += line;
    }

    return {
        data: {
            embeds:[{
                title: `Ratings Search: "${searchTerm}"`,
                description: description.trim(),
                color: 0x9b59b6, 
                author: {
                    name: `${displayName}'s Ratings`
                },
                footer: { text: `Found ${albums.length} rated album(s)` }
            }],
            components: albums.length > 0 ? [{
                type: ComponentType.ActionRow,
                components:[{
                    type: ComponentType.StringSelect,
                    custom_id: `album_search_select`,  // Utilizing your existing Select Handler
                    placeholder: "View a specific album's details...",
                    options: albums.slice(0, 25).map(a => ({
                        label: a.name.substring(0, 100),
                        description: `${a.artistName} | Year: ${a.releaseYear || 'Unknown'}`.substring(0, 100),
                        value: a.slug.substring(0, 100)
                    }))
                }]
            }] :[]
        }
    };
}