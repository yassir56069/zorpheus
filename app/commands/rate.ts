import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataNumberOption,
    ComponentType,
} from 'discord-api-types/v10';
import { getUserLastFM } from '@/utils/database/user-service';
import { upsertRating } from '@/utils/database/ratings-service';
import { getOrCreateAlbum } from '@/utils/database/album-service';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

async function editInteractionResponse(token: string, data: unknown) {
    if (!APP_ID) return;
    const url = `https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`;
    await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
}

export async function handleRate(
    interaction: APIChatInputApplicationCommandInteraction,
    waitUntil: (promise: Promise<unknown>) => void
) {
    const discordUserId = interaction.member!.user.id;
    const options = interaction.data.options ?? [];
    const starsOption = options.find(
        (opt) => opt.name === 'stars'
    ) as APIApplicationCommandInteractionDataNumberOption | undefined;

    const runBackgroundTask = async () => {
        try {
            // 1. Get User's Last.fm
            const lastfmUser = await getUserLastFM(discordUserId);
            if (!lastfmUser) {
                await editInteractionResponse(interaction.token, {
                    content: "❌ You haven't linked your Last.fm! Use `/join` first.",
                });
                return;
            }

            // 2. Fetch current scrobble
            const lfmRes = await fetch(
                `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUser}&api_key=${LASTFM_API_KEY}&limit=1&format=json`
            );
            const lfmData = await lfmRes.json();
            const track = lfmData.recenttracks?.track?.[0];

            if (!track || !track.album['#text']) {
                await editInteractionResponse(interaction.token, {
                    content: "❌ Couldn't find a recently played album to rate.",
                });
                return;
            }

            const rawAlbumName = track.album['#text'];
            const rawArtistName = track.artist['#text'];

            // 3. Fetch canonical metadata
            const albumInfoRes = await fetch(
                `http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(rawArtistName)}&album=${encodeURIComponent(rawAlbumName)}&format=json`
            );
            const albumInfoData = await albumInfoRes.json();

            const album = albumInfoData.album;
            const albumName = album?.name || rawAlbumName;
            const artistName = album?.artist || rawArtistName;
            const mbid = album?.mbid || track.album.mbid || null;
            const albumArt = album?.image?.[3]['#text'] || track.image[3]['#text'];

            let releaseYear = null;
            const dateStr = album?.releasedate?.trim();
            if (dateStr && dateStr !== '0' && dateStr !== '') {
                const match = dateStr.match(/\d{4}/);
                if (match) releaseYear = match[0];
            }
            if (!releaseYear && album?.wiki?.summary) {
                const wikiMatch = album.wiki.summary.match(/\b(19|20)\d{2}\b/);
                if (wikiMatch) releaseYear = wikiMatch[0];
            }
            if (!releaseYear && album?.tags?.tag) {
                const tags = Array.isArray(album.tags.tag) ? album.tags.tag : [album.tags.tag];
                for (const t of tags) {
                    const tagMatch = t.name.match(/^(19|20)\d{2}$/);
                    if (tagMatch) {
                        releaseYear = tagMatch[0];
                        break;
                    }
                }
            }

            // 4. Handle Instant Rating (stars option provided)
            if (starsOption) {
                const score = starsOption.value as number;
                const dbAlbum = await getOrCreateAlbum({
                    name: albumName,
                    artistName,
                    mbid,
                    releaseYear,
                    userId: discordUserId,
                });

                await upsertRating(discordUserId, dbAlbum!.slug as string, score);

                await editInteractionResponse(interaction.token, {
                    content: `✅ Rated **${albumName}** by **${artistName}**: **${score / 2}** stars.`,
                });
                return;
            }

            // 5. Handle Interactive Rating (Select Menu)
            await editInteractionResponse(interaction.token, {
                embeds: [
                    {
                        title: `Rate this album`,
                        description: `**${artistName}** - *${albumName}*`,
                        thumbnail: { url: albumArt },
                        color: 0xcc0000,
                        footer: { text: 'Select a rating below' },
                    },
                ],
                components: [
                    {
                        type: ComponentType.ActionRow,
                        components: [
                            {
                                type: ComponentType.StringSelect,
                                custom_id: `rate_select_${discordUserId}`,
                                placeholder: 'Choose a rating',
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
                                ],
                            },
                        ],
                    },
                ],
            });
        } catch (error) {
            console.error('[RATE] Background task error:', error);
            await editInteractionResponse(interaction.token, {
                content: '❌ Something went wrong while fetching your album.',
            });
        }
    };

    waitUntil(runBackgroundTask());

    return NextResponse.json({
        type: InteractionResponseType.DeferredChannelMessageWithSource,
    });
}