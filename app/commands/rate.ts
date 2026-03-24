/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataNumberOption,
    ComponentType,
    MessageFlags
} from 'discord-api-types/v10';
import { getUserLastFM } from '@/utils/database/user-service';
import { getOrCreateAlbum } from '@/utils/database/album-service';
import { upsertRating } from '@/utils/database/ratings-service';


const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

// Helper to edit the "Thinking..." message later
async function editInteractionResponse(token: string, data: any) {
    const APP_ID = process.env.DISCORD_APP_ID;
    await fetch(`https://discord.com/api/v10/webhooks/${APP_ID}/${token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
}

export async function handleRate(
    interaction: APIChatInputApplicationCommandInteraction, 
    waitUntil: (promise: Promise<any>) => void
) {
    const { token, member, data } = interaction;
    const discordUserId = member!.user.id;
    const options = data.options ?? [];
    const starsOption = options.find(opt => opt.name === 'stars') as APIApplicationCommandInteractionDataNumberOption | undefined;

    // 1. Respond immediately with a "Deferred" state (ephemeral)
    const response = NextResponse.json({
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: MessageFlags.Ephemeral } 
    });

    // 2. Perform the heavy lifting in the background
    waitUntil((async () => {
        try {
            // --- ALL YOUR EXISTING LOGIC START ---
            const lastfmUser = await getUserLastFM(discordUserId);
            if (!lastfmUser) {
                return editInteractionResponse(token, { content: "❌ You haven't linked your Last.fm! Use `/join` first." });
            }

            const lfmRes = await fetch(`http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUser}&api_key=${LASTFM_API_KEY}&limit=1&format=json`);
            const lfmData = await lfmRes.json();
            const track = lfmData.recenttracks?.track?.[0];

            if (!track || !track.album['#text']) {
                return editInteractionResponse(token, { content: "❌ Couldn't find a recently played album to rate." });
            }

            const rawAlbumName = track.album['#text'];
            const rawArtistName = track.artist['#text'];

            const albumInfoRes = await fetch(`http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_API_KEY}&artist=${encodeURIComponent(rawArtistName)}&album=${encodeURIComponent(rawAlbumName)}&format=json`);
            const albumInfoData = await albumInfoRes.json();
            
            const album = albumInfoData.album;
            const albumName = album?.name || rawAlbumName;
            const artistName = album?.artist || rawArtistName;
            const mbid = album?.mbid || track.album.mbid || null;
            const albumArt = album?.image?.[3]['#text'] || track.image[3]['#text'];

            // ... (keep your existing releaseYear parsing logic here) ...
            const releaseYear = null; 
            /* Insert your releaseYear logic from the original snippet here */

            // 3. Handle Instant Rating
            if (starsOption) {
                const score = (starsOption.value as number);
                const albumDb = await getOrCreateAlbum({ 
                    name: albumName, 
                    artistName, 
                    mbid, 
                    releaseYear, 
                    userId: discordUserId 
                });
                
                await upsertRating(discordUserId, albumDb!.slug as string, score);

                return editInteractionResponse(token, {
                    content: `✅ Rated **${albumName}** by **${artistName}**: **${score / 2}** stars.`
                });
            }

            // 4. Handle Interactive Rating (Select Menu)
            return editInteractionResponse(token, {
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
                }]
            });
            // --- ALL YOUR EXISTING LOGIC END ---

        } catch (error) {
            console.error("Error in handleRate background:", error);
            await editInteractionResponse(token, { content: "❌ An error occurred while processing your rating." });
        }
    })());

    return response;
}