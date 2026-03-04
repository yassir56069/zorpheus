import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ComponentType
} from 'discord-api-types/v10';
import { getAlbumWithStats, searchAlbums, updateAlbumCoverArt, getAlbumRatings } from '@/utils/database/album-service';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

// Helper to convert 1-10 to stars
function getStars(score: number): string {
    const fullStars = Math.floor(score / 2);
    const halfStar = score % 2 !== 0 ? '½' : '';
    const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
    return '★'.repeat(fullStars) + halfStar + '☆'.repeat(emptyStars);
}

export async function handleAlbum(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];
    const slugOption = options.find(opt => opt.name === 'slug') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!slugOption) {
        return new NextResponse('Missing slug', { status: 400 });
    }

    return await renderAlbumEmbed(slugOption.value);
}

export async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];
    const queryOption = options.find(opt => opt.name === 'query') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!queryOption) {
        return new NextResponse('Missing query', { status: 400 });
    }

    const hits = await searchAlbums(queryOption.value);

    if (hits.length === 0) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `❌ No albums found matching \`${queryOption.value}\`.`, flags: 64 }
        });
    }

    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
            content: `🔍 Found **${hits.length}** results for \`${queryOption.value}\`.\nSelect one below to view its ratings!`,
            components: [{
                type: ComponentType.ActionRow,
                components: [{
                    type: ComponentType.StringSelect,
                    custom_id: `album_search_select`,
                    placeholder: "Choose an album to view",
                    options: hits.map(hit => ({
                        label: hit.name.substring(0, 100),
                        description: `${hit.artistName} ${hit.releaseYear ? `(${hit.releaseYear})` : ''}`.substring(0, 100),
                        value: hit.slug
                    }))
                }]
            }]
        }
    });
}

export async function renderAlbumEmbed(slug: string, updateMessage: boolean = false) {
    const album = await getAlbumWithStats(slug);

    if (!album) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `❌ Could not find an album with slug \`${slug}\` in the database.`, flags: 64 }
        });
    }

    // Check and Fetch Cover Art if missing
    let coverArtUrl = album.coverArtUrl;
    if (!coverArtUrl && LASTFM_API_KEY) {
        try {
            const artistEnc = encodeURIComponent(album.artistName);
            const albumEnc = encodeURIComponent(album.name);
            const res = await fetch(`http://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${artistEnc}&album=${albumEnc}&api_key=${LASTFM_API_KEY}&format=json`);
            const data = await res.json();
            
            if (data.album?.image) {
                // Get extralarge or large image
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const img = data.album.image.find((i: any) => i.size === 'extralarge') || data.album.image.find((i: any) => i.size === 'large');
                if (img && img['#text']) {
                    coverArtUrl = img['#text'];
                    await updateAlbumCoverArt(slug, coverArtUrl as string);
                }
            }
        } catch (e) {
            console.error("Failed to fetch missing album cover:", e);
        }
    }

    // Fetch Ratings
    const ratings = await getAlbumRatings(slug);
    let ratingsDisplay = "No ratings yet.";
    
    if (ratings.length > 0) {
        ratingsDisplay = ratings.map(r => 
            `<@${r.userId}>: **${r.score / 2}** ${getStars(r.score)}`
        ).join('\n');
    }

    // Embed Construction
    const embed = {
        title: `${album.artistName} - ${album.name}`,
        description: `**Release Year:** ${album.releaseYear || 'Unknown'}\n\n` + 
                     `📊 **Average Score:** ${album.avgScore ? (album.avgScore / 2).toFixed(2) : 'N/A'}/5\n` + 
                     `🏆 **Overall Rank:** ${album.rank ? `#${album.rank}` : 'Unranked'}\n` + 
                     `👥 **Total Ratings:** ${album.ratingCount || 0}\n\n` +
                     `**Community Ratings:**\n${ratingsDisplay}`,
        color: 0x3498db,
        thumbnail: coverArtUrl ? { url: coverArtUrl } : undefined,
        footer: { text: `Slug: ${album.slug}` }
    };

    return NextResponse.json({
        type: updateMessage ? InteractionResponseType.UpdateMessage : InteractionResponseType.ChannelMessageWithSource,
        data: {
            content: "",
            embeds: [embed],
            components: [] // Clears components if this was an update from the select menu
        }
    });
}