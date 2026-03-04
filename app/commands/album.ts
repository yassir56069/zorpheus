/* eslint-disable @typescript-eslint/no-explicit-any */
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
    if (!APP_ID) {
        console.error("Missing DISCORD_APPLICATION_ID in environment variables.");
        return;
    }

    const url = `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error("Discord Webhook Update Failed:", errorText);
    }
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleAlbum(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    const options = interaction.data.options ?? [];
    const slugOption = options.find(opt => opt.name === 'slug-value') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!slugOption) return new NextResponse('Missing slug', { status: 400 });

    // 1. Kick off background work
    waitUntil((async () => {
        try {
            const result = await renderAlbumEmbed(slugOption.value);
            await editInteractionResponse(interaction.token, result.data);
        } catch (e) {
            console.error("Error in handleAlbum background task:", e);
        }
    })());

    // 2. Respond immediately with defer
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

/**
 * COMMAND: /album-search
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleAlbumSearch(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    const options = interaction.data.options ?? [];
    const queryOption = options.find(opt => opt.name === 'searchterm') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!queryOption) return new NextResponse('Missing query', { status: 400 });

    waitUntil((async () => {
        try {
            const hits = await searchAlbums(queryOption.value);
            if (hits.length === 0) {
                await editInteractionResponse(interaction.token, { content: `❌ No albums found matching \`${queryOption.value}\`.` });
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
        } catch (e) {
            console.error("Error in handleAlbumSearch background task:", e);
        }
    })());

    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}

/**
 * RE-USABLE: Generates the Embed Data
 */
export async function renderAlbumEmbed(slug: string) {
    const album = await getAlbumWithStats(slug);

    if (!album) {
        return { data: { content: `❌ Could not find album \`${slug}\` in database.` } };
    }

    let coverArtUrl = album.coverArtUrl;
    if (!coverArtUrl && LASTFM_API_KEY) {
        try {
            const res = await fetch(`http://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${encodeURIComponent(album.artistName)}&album=${encodeURIComponent(album.name)}&api_key=${LASTFM_API_KEY}&format=json`);
            const data = await res.json();
            const img = data.album?.image?.find((i: any) => i.size === 'extralarge') || data.album?.image?.find((i: any) => i.size === 'large');
            if (img?.['#text']) {
                coverArtUrl = img['#text'];
                await updateAlbumCoverArt(slug, coverArtUrl as string);
            }
        } catch (e) { console.error("Last.fm Fetch Error:", e); }
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