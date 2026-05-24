/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ComponentType,
    APIApplicationCommandInteractionDataIntegerOption
} from 'discord-api-types/v10';
import { 
    getAlbumWithStats, 
    searchAlbums, 
    updateAlbumCoverArt, 
    getAlbumRatings, 
    getOrCreateAlbum, 
    canonizeAlbum,
    searchArtists,
    canonizeAlbumById,
    MIN_RATINGS_TO_RANK
} from '@/utils/database/album-service';
import { getUserLastFM } from '@/utils/database/user-service';
import { getMergedAlbumGenres } from '@/utils/database/genre-service';
import { FEATURE_ELIGIBLE_MAX_RATINGS, getAlbumFeatureInfo, getAlbumFeaturedState  } from '@/utils/database/feature-service';


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

function formatAlbumStats(
    avgScore: number | null, 
    weightedScore: number | null, 
    rank: number | null, 
    totalRatings: number,
    featureScore?: number | null // <-- Now taking featureScore
): string {
    const isRanked = rank !== null;
    
    const activeScore = (isRanked && weightedScore !== null) ? weightedScore : avgScore;
    const rawScore = activeScore !== null ? (Number(activeScore) / 2) : null;
    const scoreStr = rawScore !== null ? rawScore.toFixed(2) : "N/A";

    const rankDisplay = isRanked ? `#${rank}` : "Unranked";

    let scoreColor = "\u001b[1;33m";
    let rankColor = "\u001b[1;34m";

    if (!isRanked) {
        scoreColor = "\u001b[1;30m";
        rankColor = "\u001b[1;30m";
    } else {
        if (rawScore !== null) {
            if (rawScore >= 4.0) scoreColor = "\u001b[1;32m";
            else if (rawScore < 3.0) scoreColor = "\u001b[1;31m";
        }
        if (rank <= 10) rankColor = "\u001b[1;35m";
        else if (rank <= 50) rankColor = "\u001b[1;33m";
    }

    // Insert Feature Score line right under Score if it exists
    const featureScoreLine = featureScore !== null && featureScore !== undefined
        ? `\n\u001b[2;34m 🌟 Feature Score : \u001b[1;36m${featureScore}\u001b[0m` 
        : "";

    return `\`\`\`ansi
\u001b[2;34m ⭐ Score         : ${scoreColor}${scoreStr}\u001b[0m${featureScoreLine}
\u001b[2;34m 🏆 Overall Rank  : ${rankColor}${rankDisplay}\u001b[0m
\u001b[2;34m 👥 Total Ratings : \u001b[1;34m${totalRatings}\u001b[0m
\`\`\``;
}


export async function handleAlbum(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    console.log("[ALBUM] Received /album command");
    const options = interaction.data.options ?? [];
    const slugOption = options.find(opt => opt.name === 'slug-value') as APIApplicationCommandInteractionDataStringOption | undefined;
    
    const discordUserId = interaction.member?.user?.id || interaction.user?.id;

    const runBackgroundTask = async () => {
        try {
            let targetSlug: string | undefined = slugOption?.value;

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

                targetSlug = albumRecord.slug as string;
                console.log(`[ALBUM] Derived slug from current track: ${targetSlug}`);
            }

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

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

export async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    console.log("[ALBUM] Received /album-search command");
    const options = interaction.data.options ?? [];
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

            const seenValues = new Set<string>();
            const uniqueOptions = [];

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
                components: [{
                    type: ComponentType.ActionRow,
                    components: [{
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

    const ratings = await getAlbumRatings(album.slug);
    const genres = await getMergedAlbumGenres(album.slug);

    const artistHits = await searchArtists(album.artistName);
    const exactArtist = artistHits.find(h => h.artistName.toLowerCase() === album.artistName.toLowerCase()) || artistHits[0];
    const albumCount = exactArtist ? exactArtist.albumCount : 1;
    
    const ratingsDisplay = ratings.length > 0 
        ? ratings.map(r => `<@${r.userId}>: **${(r.score / 2).toFixed(1)}** ${getStars(r.score)}`).join('\n')
        : "No ratings yet.";

    const genresDisplay = genres.length > 0
        ? `🏷️ **Genres:** ${genres.map(g => `\`${titleCase(g)}\``).join(', ')}\n\n`
        : '';

    // Determine feature state early so we can use it for stats
    const ratingCount = album.ratingCount || 0;
    const isFeatured = await getAlbumFeaturedState(album.slug);
    
    // Check if album is featured (1 or 2) and fetch its stats
    let featureScore: number | null = null;
    let featuredDateDisplay = '';
    
    if (isFeatured > 0) {
        const featureInfo = await getAlbumFeatureInfo(album.slug);
        if (featureInfo) {
            featureScore = featureInfo.featureScore;
            // Parse the ISO date (YYYY-MM-DD) as UTC, then get Unix timestamp for Discord
            const unixTimestamp = Math.floor(new Date(featureInfo.startDate + 'T00:00:00.000Z').getTime() / 1000);
            featuredDateDisplay = `💽 **Featured On:** <t:${unixTimestamp}:D>\n\n`; 
        }
    }

    const statsBlock = formatAlbumStats(
        album.avgScore, 
        album.weightedScore ?? null, 
        album.rank, 
        album.ratingCount || 0,
        featureScore 
    );

    // Determine feature button state
    const isFeatureEligible = ratingCount === FEATURE_ELIGIBLE_MAX_RATINGS && isFeatured === 0;
    const isCurrentlyFeatured = isFeatured === 1;
    const wasEverFeatured = isFeatured === 2;
    const isAlreadyRanked = ratingCount >= MIN_RATINGS_TO_RANK;

    // Build the bottom action row depending on album state
    const bottomRowButtons: any[] = [
        {
            type: 2, // Button
            style: 2, // Secondary (grey)
            custom_id: `view_artist:${album.id}`,
            label: `${album.artistName} (${albumCount} Album${albumCount !== 1 ? 's' : ''})`,
            emoji: { name: '👨‍🎤' }
        }
    ];

    if (isFeatureEligible) {
        // Album is one rating away from ranking — show the nominate button
        bottomRowButtons.push({
            type: 2,
            style: 1, // Primary (blurple)
            custom_id: `feature_nominate:${album.slug}`,
            label: `Nominate for Featured`,
            emoji: { name: '⭐' }
        });
    } else if (isCurrentlyFeatured) {
        // Show a disabled indicator that it's currently the featured album
        bottomRowButtons.push({
            type: 2,
            style: 2,
            custom_id: `feature_noop`,
            label: `Currently Featured`,
            emoji: { name: '🌟' },
            disabled: true
        });
    } else if (wasEverFeatured) {
        // Show a disabled indicator that it's already had its week
        bottomRowButtons.push({
            type: 2,
            style: 2,
            custom_id: `feature_noop`,
            label: `Previously Featured`,
            emoji: { name: '📅' },
            disabled: true
        });
    } else if (isAlreadyRanked) {
        // Ranked albums are ineligible — no button needed, but you could add one if desired
        // Leave it absent to keep the embed clean
    }

    return {
        data: {
            embeds: [{
                title: `${isFeatured > 0 ? '📀 ' : ''}${album.artistName} - ${album.name}`,
                description: `**Release Year:** ${album.releaseYear || 'Unknown'}\n\n` + 
                             genresDisplay +
                             featuredDateDisplay + 
                             statsBlock +
                             `\n**Community Ratings:**\n${ratingsDisplay}`,
                color: isCurrentlyFeatured ? 0xf5a623 : 0x3498db, // Gold if featured, blue otherwise
                thumbnail: coverArtUrl ? { url: coverArtUrl } : undefined,
                footer: { text: `ID: ${album.id} | Slug: ${album.slug}` }
            }],
            components: [
                {
                    type: ComponentType.ActionRow,
                    components: [{
                        type: ComponentType.StringSelect,
                        custom_id: `rate_album_embed`,
                        placeholder: "Rate this album",
                        options: [
                            { label: '[5.0] ★★★★★', value: '10' },
                            { label: '[4.5] ★★★★½', value: '9' },
                            { label: '[4.0] ★★★★', value: '8' },
                            { label: '[3.5] ★★★½', value: '7' },
                            { label: '[3.0] ★★★', value: '6' },
                            { label: '[2.5] ★★½', value: '5' },
                            { label: '[2.0] ★★', value: '4' },
                            { label: '[1.5] ★½', value: '3' },
                            { label: '[1.0] ★', value: '2' },
                            { label: '[0.5] ½', value: '1' },
                        ]
                    }]
                },
                {
                    type: ComponentType.ActionRow,
                    components: bottomRowButtons
                }
            ]
        }
    };
}

export async function handleCanonizeAlbum(
    interaction: APIChatInputApplicationCommandInteraction, 
    waitUntil: (promise: Promise<any>) => void
) {
    console.log("[ALBUM] Received /canonize-album command");

    const options = interaction.data.options ?? [];
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

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

export async function handleCanonizeAlbumById(
    interaction: APIChatInputApplicationCommandInteraction, 
    waitUntil: (promise: Promise<any>) => void
) {
    console.log("[ALBUM] Received /canonize-album-id command");

    const options = interaction.data.options ?? [];
    const targetIdOpt = options.find(opt => opt.name === 'target-id') as APIApplicationCommandInteractionDataIntegerOption | undefined;
    const canonIdOpt = options.find(opt => opt.name === 'canon-id') as APIApplicationCommandInteractionDataIntegerOption | undefined;

    if (!targetIdOpt || !canonIdOpt) {
         return new NextResponse('Missing required arguments', { status: 400 });
    }

    const targetId = targetIdOpt.value as number;
    const canonId = canonIdOpt.value as number;
    const userId = interaction.member!.user.id;

    const runBackgroundTask = async () => {
        try {
            console.log(`[ALBUM] Attempting to canonize by ID: ${targetId} -> ${canonId}`);
            if (userId == '508817156847173632' || userId == '259786443679858689' || userId == '959791198938230784') {
                const result = await canonizeAlbumById(targetId, canonId);
                await editInteractionResponse(interaction.token, {
                    content: result.success 
                        ? `🔗 **Success:** ${result.message}` 
                        : `❌ **Failed:** ${result.message}`
                });
            } else {
                await editInteractionResponse(interaction.token, { 
                    content: `❌ No Canonizing for you 😾😾. Contact me if you need/want to use this command!` 
                });
            }
        } catch (error) {
            console.error(`[ALBUM] FATAL error in canonize-album-id task:`, error);
            await editInteractionResponse(interaction.token, { 
                content: `❌ An internal error occurred while canonizing the album.` 
            });
        }
    };

    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}