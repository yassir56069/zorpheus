/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ComponentType
} from 'discord-api-types/v10';
import { 
    getAlbumWithStats, 
    searchAlbums, 
    updateAlbumCoverArt, 
    getAlbumRatings, 
    getOrCreateAlbum, 
    canonizeAlbum
} from '@/utils/database/album-service';
import { getUserLastFM } from '@/utils/database/user-service';
import { getMergedAlbumGenres } from '@/utils/database/genre-service';


const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

export async function editInteractionResponse(token: string, data: any) {
    if (!APP_ID) {
        console.error("[ALBUM] ERROR: Missing DISCORD_APPLICATION_ID");
        return;
    }

    const url = `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`;
    console.log(`[ALBUM] Updating interaction via webhook: ${url}`);
    
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`[ALBUM] Discord Webhook Update Failed: ${res.status}`, errorText);
    } else {
        console.log("[ALBUM] Discord Webhook Update Successful");
    }
}

function getStars(score: number): string {
    const fullStars = Math.floor(score / 2);
    const halfStar = score % 2 !== 0 ? '½' : '';
    const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
    return '★'.repeat(fullStars) + halfStar + '☆'.repeat(emptyStars);
}

function titleCase(str: string): string {
    return str.replace(
        /\w\S*/g,
        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
}

function ansiRating(score: number | null) {
    if (score == null) {
        return "```ansi\nN/A\n```";
    }

    const rating = (Number(score) / 2).toFixed(2);

    return `\`\`\`ansi
\u001b[2;40m\u001b[2;33m\u001b[2;34m 📊 Average Rating: \u001b[1;34m\u001b[1;33m${rating}\u001b[0m\u001b[1;34m\u001b[1;40m\u001b[0m\u001b[2;34m\u001b[2;40m\u001b[0m\u001b[2;33m\u001b[2;40m\u001b[0m\u001b[2;40m\u001b[0m
\`\`\``;
}

export async function handleAlbum(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    console.log("[ALBUM] Received /album command");
    const options = interaction.data.options ??[];
    const slugOption = options.find(opt => opt.name === 'slug-value') as APIApplicationCommandInteractionDataStringOption | undefined;
    
    // Support both server and DM interactions
    const discordUserId = interaction.member?.user?.id || interaction.user?.id;

    // Define the background task
    const runBackgroundTask = async () => {
        try {
            // Explicitly type as string | undefined
            let targetSlug: string | undefined = slugOption?.value;

            // --- NEW LOGIC: If no slug provided, fetch from Last.fm ---
            if (!targetSlug) {
                console.log(`[ALBUM] No slug provided, fetching current Last.fm track for user ${discordUserId}`);
                
                const lastfmUsername = await getUserLastFM(discordUserId as string) as string | null;
                
                if (!lastfmUsername) {
                    await editInteractionResponse(interaction.token, {
                        content: `You haven't registered your Last.fm username yet! Use the \`/register\` command first, or provide an album slug directly.`
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
                        content: `Your current track (**${track.name}** by **${artist}**) doesn't have an album associated with it. Please provide an album slug directly.`
                    });
                    return;
                }

                console.log(`[ALBUM] Found current album: ${albumName} by ${artist}. Checking database...`);
                
                // Get or create the album to ensure it exists and get the exact canonical slug
                const albumRecord = await getOrCreateAlbum({
                    name: albumName,
                    artistName: artist,
                    mbid: albumMbid,
                    userId: discordUserId as string
                });

                if (!albumRecord) {
                    await editInteractionResponse(interaction.token, {
                        content: `❌ Failed to process the album **${albumName}** by **${artist}**.`
                    });
                    return;
                }

                // FIX: Cast the LibSQL 'Value' type to 'string'
                targetSlug = albumRecord.slug as string;
                console.log(`[ALBUM] Derived slug from current track: ${targetSlug}`);
            }
            // --- END NEW LOGIC ---

            // Fallback safety catch so renderAlbumEmbed doesn't get undefined
            if (!targetSlug) {
                 await editInteractionResponse(interaction.token, { 
                    content: `❌ Could not resolve the album slug.` 
                });
                return;
            }

            console.log(`[ALBUM] Starting renderAlbumEmbed for: ${targetSlug}`);
            const result = await renderAlbumEmbed(targetSlug);
            console.log(`[ALBUM] renderAlbumEmbed finished for: ${targetSlug}`);
            await editInteractionResponse(interaction.token, result.data);

        } catch (error) {
            console.error(`[ALBUM] FATAL error in background task:`, error);
            await editInteractionResponse(interaction.token, { 
                content: `❌ An internal error occurred while retrieving the album.` 
            });
        }
    };

    // Defers the response and runs task in background
    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

export async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    console.log("[ALBUM] Received /album-search command");
    const options = interaction.data.options ??[];
    const queryOption = options.find(opt => opt.name === 'searchterm') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!queryOption) return new NextResponse('Missing query', { status: 400 });

    const searchTerm = queryOption.value;

    if (searchTerm.length > 100) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `❌ Search term is too long (${searchTerm.length} characters). Please keep it under 100 characters.`
            }
        });
    }

    const runBackgroundTask = async () => {
        try {
            console.log(`[ALBUM] Searching for: ${searchTerm}`);
            const hits = await searchAlbums(searchTerm);
            
            if (hits.length === 0) {
                await editInteractionResponse(interaction.token, { content: `❌ No albums found matching \`${searchTerm}\`.` });
                return;
            }

            // FIX: Deduplicate truncated slugs to prevent Discord 400 Bad Request errors 
            // from identical values (caused by artist names exceeding 100 chars).
            const seenValues = new Set<string>();
            const uniqueOptions =[];

            for (const hit of hits) {
                const value = hit.slug.substring(0, 100);
                if (!seenValues.has(value)) {
                    seenValues.add(value);
                    uniqueOptions.push({
                        label: hit.name.substring(0, 100),
                        description: `${hit.artistName} ${hit.releaseYear ? `(${hit.releaseYear})` : ''}`.substring(0, 100),
                        value: value
                    });
                }
            }

            await editInteractionResponse(interaction.token, {
                content: `🔍 Found **${hits.length}** results for \`${searchTerm}\`.\nSelect one below to view its ratings!`,
                components:[{
                    type: ComponentType.ActionRow,
                    components:[{
                        type: ComponentType.StringSelect,
                        custom_id: `album_search_select`,
                        placeholder: "Choose an album to view",
                        options: uniqueOptions
                    }]
                }]
            });
        } catch (error) {
            console.error("[ALBUM] Search Background Error:", error);
        }
    };

    waitUntil(runBackgroundTask());

    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

export async function renderAlbumEmbed(slug: string) {
    const album = await getAlbumWithStats(slug);

    if (!album) {
        return { data: { content: `❌ Could not find album \`${slug}\` in database.` } };
    }

    let coverArtUrl = album.coverArtUrl;
    if (!coverArtUrl && LASTFM_API_KEY) {
        try {
            const res = await fetch(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(album.artistName)}&album=${encodeURIComponent(album.name)}&api_key=${LASTFM_API_KEY}&format=json`);
            const data = await res.json();
            const img = data.album?.image?.find((i: any) => i.size === 'extralarge') || data.album?.image?.find((i: any) => i.size === 'large');
            if (img?.['#text']) {
                coverArtUrl = img['#text'];
                await updateAlbumCoverArt(album.slug, coverArtUrl as string);
            }
        } catch (e) { 
            console.error("[ALBUM] Last.fm fetch error:", e); 
        }
    }

    // Fetch associated data
    const ratings = await getAlbumRatings(album.slug);
    const genres = await getMergedAlbumGenres(album.slug);
    
    const ratingsDisplay = ratings.length > 0 
        ? ratings.map(r => `<@${r.userId}>: **${(r.score / 2).toFixed(1)}** ${getStars(r.score)}`).join('\n')
        : "No ratings yet.";

    const genresDisplay = genres.length > 0
        ? `🏷️ **Genres:** ${genres.map(g => `\`${titleCase(g)}\``).join(', ')}\n\n`
        : ''; // If no genres, it won't render the line

    const displayScoreAnsi = ansiRating(album.avgScore);
    const displayRank = album.rank ? `#${album.rank}` : 'Unranked';

    return {
        data: {
            embeds:[{
                title: `${album.artistName} - ${album.name}`,
                description: `**Release Year:** ${album.releaseYear || 'Unknown'}\n\n` + 
                             genresDisplay +
                                `\n${displayScoreAnsi}\n` +
                             `🏆 **Overall Rank:** \`${displayRank}\`\n` + 
                             `👥 **Total Ratings:** \`${album.ratingCount || 0}\`\n\n` +
                             `**Community Ratings:**\n${ratingsDisplay}`,
                color: 0x3498db,
                thumbnail: coverArtUrl ? { url: coverArtUrl } : undefined,
                footer: { text: `Slug: ${album.slug}` }
            }]
        }
    };
}



export async function handleCanonizeAlbum(
    interaction: APIChatInputApplicationCommandInteraction, 
    waitUntil: (promise: Promise<any>) => void
) {
    console.log("[ALBUM] Received /canonize-album command");
    
    // Optional check: You can verify the user's admin status here if you aren't using Discord's default_member_permissions
    // const memberPermissions = BigInt(interaction.member?.permissions || "0");
    // const isAdmin = (memberPermissions & BigInt(0x8)) === BigInt(0x8);
    // if (!isAdmin) return new NextResponse('Unauthorized', { status: 403 });

    const options = interaction.data.options ??[];
    const targetSlugOpt = options.find(opt => opt.name === 'target-slug') as APIApplicationCommandInteractionDataStringOption | undefined;
    const canonSlugOpt = options.find(opt => opt.name === 'canon-slug') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!targetSlugOpt || !canonSlugOpt) {
         return new NextResponse('Missing required arguments', { status: 400 });
    }

    const targetSlug = targetSlugOpt.value;
    const canonSlug = canonSlugOpt.value;

    const runBackgroundTask = async () => {
        try {
            console.log(`[ALBUM] Attempting to canonize: ${targetSlug} -> ${canonSlug}`);
            const result = await canonizeAlbum(targetSlug, canonSlug);

            await editInteractionResponse(interaction.token, {
                content: result.success 
                    ? `🔗 **Success:** ${result.message}` 
                    : `❌ **Failed:** ${result.message}`
            });

        } catch (error) {
            console.error(`[ALBUM] FATAL error in canonize-album task:`, error);
            await editInteractionResponse(interaction.token, { 
                content: `❌ An internal error occurred while canonizing the album.` 
            });
        }
    };

    // Defer the interaction immediately, process in background
    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}