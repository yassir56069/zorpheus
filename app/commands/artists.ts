/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ComponentType,
} from 'discord-api-types/v10';
import { 
    searchArtists,
    getArtistAlbums,
    MIN_RATINGS_TO_RANK,
} from '@/utils/database/album-service';
import { editInteractionResponse } from './album';




export async function handleArtistSearch(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    console.log("[ARTIST] Received /artist-search command");
    const options = interaction.data.options ??[];
    const queryOption = options.find(opt => opt.name === 'searchterm') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!queryOption) return new NextResponse('Missing query', { status: 400 });
    const searchTerm = queryOption.value;

    if (searchTerm.length > 100) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `❌ Search term is too long. Please keep it under 100 characters.` }
        });
    }

    const runBackgroundTask = async () => {
        try {
            console.log(`[ARTIST] Searching for: ${searchTerm}`);
            const hits = await searchArtists(searchTerm);
            
            if (hits.length === 0) {
                await editInteractionResponse(interaction.token, { content: `❌ No artists found matching \`${searchTerm}\`.` });
                return;
            }

            const uniqueOptions = hits.map(hit => {
                const value = hit.artistName.substring(0, 100);
                return {
                    label: hit.artistName.substring(0, 100),
                    description: `${hit.albumCount} album${hit.albumCount === 1 ? '' : 's'} logged`,
                    value: value
                };
            });

            await editInteractionResponse(interaction.token, {
                content: `👨‍🎤 Found **${hits.length}** artists for \`${searchTerm}\`.\nSelect one below to view their discography!`,
                components:[{
                    type: ComponentType.ActionRow,
                    components:[{
                        type: ComponentType.StringSelect,
                        custom_id: `artist_search_select`,
                        placeholder: "Choose an artist to view",
                        options: uniqueOptions
                    }]
                }]
            });
        } catch (error) {
            console.error("[ARTIST] Search Background Error:", error);
        }
    };

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}


function getStars(score: number): string {
    const fullStars = Math.floor(score / 2);
    const halfStar = score % 2 !== 0 ? '½' : '';
    const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
    return '★'.repeat(fullStars) + halfStar + '☆'.repeat(emptyStars);
}


export async function renderArtistEmbed(artistName: string) {
    const albums = await getArtistAlbums(artistName);

    if (!albums || albums.length === 0) {
        return { data: { content: `❌ Could not find any albums for artist \`${artistName}\` in database.` } };
    }

    const formatLine = (a: typeof albums[0]) => {
        const isRanked = a.ratingCount >= MIN_RATINGS_TO_RANK;
        
        // Use weighted Bayesian score if it qualifies, otherwise raw average
        const activeScore = (isRanked && a.weightedScore !== null) ? a.weightedScore : a.avgScore;
        
        // Add the year prefix at the start of the line
        const yearPrefix = `\`[${a.releaseYear || '????'}]\``;

        if (activeScore === null) {
            return `${yearPrefix} **0.0** ☆☆☆☆☆: \`${a.name}\` *(👥 ${a.ratingCount})*`;
        }

        // Convert the /10 score to a /5 float string (e.g. 4.1)
        const rawScore = (Number(activeScore) / 2).toFixed(1);
        
        // getStars expects an integer out of 10. We round the DB float to get accurate half-stars
        const starInt = Math.round(Number(activeScore));
        const starsDisplay = getStars(starInt);
        
        return `${yearPrefix} **${rawScore}** ${starsDisplay} : \`${a.name}\` *(👥 ${a.ratingCount})*`;
    };

    let description = "";

    for (const album of albums) {
        const line = formatLine(album) + "\n";
        
        // Discord embeds max out at 4096. Truncating here to play it safe.
        if (description.length + line.length > 3900) {
            description += `*...and more (character limit reached)*\n`;
            break;
        }
        
        description += line;
    }

    return {
        data: {
            embeds:[{
                title: `Discography: ${artistName}`,
                description: description.trim(),
                color: 0x9b59b6, // Purple-ish
                footer: { text: `Total Albums: ${albums.length} | Bayesian scores require ${MIN_RATINGS_TO_RANK} global ratings` }
            }],
            components: albums.length > 0 ? [{
                type: ComponentType.ActionRow,
                components:[{
                    type: ComponentType.StringSelect,
                    custom_id: `album_search_select`, 
                    placeholder: "View a specific album's details...",
                    options: albums.slice(0, 25).map(a => ({
                        label: a.name.substring(0, 100),
                        description: `Year: ${a.releaseYear || 'Unknown'} | Ratings: ${a.ratingCount}`,
                        value: a.slug.substring(0, 100)
                    }))
                }]
            }] :[]
        }
    };
}