import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ComponentType
} from 'discord-api-types/v10';
import { getAlbumWithStats, searchAlbums, updateAlbumCoverArt, getAlbumRatings } from '@/utils/database/album-service';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

// Helper to update the "Thinking..." message
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function editInteractionResponse(token: string, data: any) {
    const url = `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`;
    await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
}

function getStars(score: number): string {
    const fullStars = Math.floor(score / 2);
    const halfStar = score % 2 !== 0 ? '½' : '';
    const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
    return '★'.repeat(fullStars) + halfStar + '☆'.repeat(emptyStars);
}

/**
 * COMMAND: /album
 */
export async function handleAlbum(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];
    // Changed 'slug' to 'slug-value' to match your register-commands script
    const slugOption = options.find(opt => opt.name === 'slug-value') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!slugOption) return new NextResponse('Missing slug', { status: 400 });

    // 1. Send Deferred Response (Immediate)
    const response = NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });

    // 2. Perform heavy lifting in background
    (async () => {
        const result = await renderAlbumEmbed(slugOption.value);
        await editInteractionResponse(interaction.token, result.data);
    })();

    return response;
}

/**
 * COMMAND: /album-search
 */
export async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];
    // Changed 'query' to 'searchterm' to match your register-commands script
    const queryOption = options.find(opt => opt.name === 'searchterm') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!queryOption) return new NextResponse('Missing query', { status: 400 });

    // 1. Send Deferred Response (Immediate)
    const response = NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });

    // 2. Perform search in background
    (async () => {
        const hits = await searchAlbums(queryOption.value);

        if (hits.length === 0) {
            await editInteractionResponse(interaction.token, {
                content: `❌ No albums found matching \`${queryOption.value}\`.`
            });
            return;
        }

        await editInteractionResponse(interaction.token, {
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
        });
    })();

    return response;
}

/**
 * RE-USABLE: Generates the Embed Data
 */
export async function renderAlbumEmbed(slug: string, isUpdate: boolean = false) {
    const album = await getAlbumWithStats(slug);

    if (!album) {
        return { data: { content: `❌ Could not find album \`${slug}\` in database.` } };
    }

    let coverArtUrl = album.coverArtUrl;
    if (!coverArtUrl && LASTFM_API_KEY) {
        try {
            const res = await fetch(`http://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(album.artistName)}&album=${encodeURIComponent(album.name)}&api_key=${LASTFM_API_KEY}&format=json`);
            const data = await res.json();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const img = data.album?.image?.find((i: any) => i.size === 'extralarge') || data.album?.image?.find((i: any) => i.size === 'large');
            if (img?.['#text']) {
                coverArtUrl = img['#text'];
                await updateAlbumCoverArt(slug, coverArtUrl as string);
            }
        } catch (e) { console.error(e); }
    }

    const ratings = await getAlbumRatings(slug);
    const ratingsDisplay = ratings.length > 0 
        ? ratings.map(r => `<@${r.userId}>: **${r.score / 2}** ${getStars(r.score)}`).join('\n')
        : "No ratings yet.";

    return {
        data: {
            content: "",
            embeds: [{
                title: `${album.artistName} - ${album.name}`,
                description: `**Release Year:** ${album.releaseYear || 'Unknown'}\n\n` + 
                             `📊 **Average Score:** ${album.avgScore ? (album.avgScore / 2).toFixed(2) : 'N/A'}/5\n` + 
                             `🏆 **Overall Rank:** ${album.rank ? `#${album.rank}` : 'Unranked'}\n` + 
                             `👥 **Total Ratings:** ${album.ratingCount || 0}\n\n` +
                             `**Community Ratings:**\n${ratingsDisplay}`,
                color: 0x3498db,
                thumbnail: coverArtUrl ? { url: coverArtUrl } : undefined,
                footer: { text: `Slug: ${album.slug}` }
            }],
            components: []
        }
    };
}