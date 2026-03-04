import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataNumberOption,
    ComponentType,
} from 'discord-api-types/v10';
import { getUserLastFM } from '@/utils/database/user-service';
import { getOrCreateAlbum, upsertRating } from '@/utils/database/ratings-service';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

export async function handleRate(interaction: APIChatInputApplicationCommandInteraction) {
    const discordUserId = interaction.member!.user.id;
    const options = interaction.data.options ?? [];
const starsOption = options.find(
    (opt) => opt.name === 'stars'
) as APIApplicationCommandInteractionDataNumberOption | undefined;

    // 1. Get User's Last.fm
    const lastfmUser = await getUserLastFM(discordUserId);
    if (!lastfmUser) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ You haven't linked your Last.fm! Use `/join` first.", flags: 64 }
        });
    }

    // 2. Fetch current scrobble
    const lfmRes = await fetch(`http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUser}&api_key=${LASTFM_API_KEY}&limit=1&format=json`);
    const lfmData = await lfmRes.json();
    const track = lfmData.recenttracks?.track?.[0];

    if (!track || !track.album['#text']) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ Couldn't find a recently played album to rate.", flags: 64 }
        });
    }

    const albumName = track.album['#text'];
    const artistName = track.artist['#text'];
    const mbid = track.album.mbid;
    const albumArt = track.image[3]['#text'] || track.image[2]['#text'];

    // 3. Handle Instant Rating
    if (starsOption) {
        const score = (starsOption.value as number) * 2; // Convert 3.5 -> 7
        const album = await getOrCreateAlbum({ name: albumName, artistName, mbid, userId: discordUserId });
        
        // Note: Using slug as albumId reference in ratings table as requested, 
        // but often database IDs are safer. Using slug here to match your logic.
        await upsertRating(discordUserId, album!.slug as string, score);

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { 
                content: `✅ Rated **${albumName}** by **${artistName}**: **${starsOption.value}** stars.` 
            }
        });
    }

    // 4. Handle Interactive Rating (Select Menu)
    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
            embeds: [{
                title: `Rate this album`,
                description: `**${artistName}** - *${albumName}*`,
                thumbnail: { url: albumArt },
                color: 0xcc0000,
                footer: { text: "Select a rating below" }
            }],
            components: [{
                type: ComponentType.ActionRow,
                components: [{
                    type: ComponentType.StringSelect,
                    custom_id: `rate_select_${discordUserId}`,
                    placeholder: "Choose a rating",
                    options: [
                        { name: '[5.0] ★★★★★', value: 5 },
                        { name: '[4.5] ★★★★½ ', value: 4.5 },
                        { name: '[4.0] ★★★★', value: 4 },
                        { name: '[3.5] ★★★½', value: 3.5 },
                        { name: '[3.0] ★★★', value: 3 },
                        { name: '[2.5] ★★½', value: 2.5 },
                        { name: '[2.0] ★★', value: 2 },
                        { name: '[1.5] ★½', value: 1.5 },
                        { name: '[1.0] ★', value: 1 },
                        { name: '[0.5] ½', value: 0.5 },
                    ]
                }]
            }]
        }
    });
}