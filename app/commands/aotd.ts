import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIEmbed
} from 'discord-api-types/v10';

import { 
    getAlbumWithStats, 
    getRandomTopUnhighlightedAlbum, 
    markAlbumAsHighlighted 
} from '@/utils/database/album-service';
import { editInteractionResponse, renderAlbumEmbed } from './album';

import { 
    fetchImageBuffer, 
    isValidImageUrl, 
    findCoverArt 
} from './rc';

const APP_ID = process.env.DISCORD_APPLICATION_ID;

export async function handleAlbumHighlight(
    interaction: APIChatInputApplicationCommandInteraction, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    waitUntil: (promise: Promise<any>) => void
) {
    console.log("[HIGHLIGHT] Received /album-highlight command");

    const TOP_ALBUM_LIMIT = 30;

    // Defer immediately with a direct fetch — same pattern as handleTopChart
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    if (!APP_ID) {
        console.error("[HIGHLIGHT] Missing DISCORD_APPLICATION_ID");
        return new NextResponse(null, { status: 204 });
    }

    try {
        // 1. Get a random unhighlighted album from the top list
        const targetSlug = await getRandomTopUnhighlightedAlbum(TOP_ALBUM_LIMIT);

        if (!targetSlug) {
            await editInteractionResponse(interaction.token, {
                content: `❌ Could not find any unhighlighted albums in the top **${TOP_ALBUM_LIMIT}**! Try rating more albums.`
            });
            return new NextResponse(null, { status: 204 });
        }

        // 2. Mark the album as highlighted in the database
        await markAlbumAsHighlighted(targetSlug);

        // 3. Render the standard album embed
        const result = await renderAlbumEmbed(targetSlug);
        const embedData = result.data;
        
        if (!embedData.embeds || embedData.embeds.length === 0) {
            await editInteractionResponse(interaction.token, {
                content: embedData.content || `❌ Failed to generate the album display for slug: \`${targetSlug}\`.`
            });
            return new NextResponse(null, { status: 204 });
        }
        
        const embed: APIEmbed = embedData.embeds[0];

        const album = await getAlbumWithStats(targetSlug);
        if (!album) throw new Error(`Album slug ${targetSlug} was found but getAlbumWithStats failed.`);

        let finalAlbumArtUrl = album.coverArtUrl;

        // 4. Resolve high-resolution image
        if (!await isValidImageUrl(finalAlbumArtUrl)) {
            finalAlbumArtUrl = await findCoverArt(album.artistName, album.name);
        }

        // 5. Send payload back to Discord
        if (finalAlbumArtUrl) {
            finalAlbumArtUrl = finalAlbumArtUrl.replace(/\/\d+x\d+\//, "/1000x1000/");
            const imageBuffer = await fetchImageBuffer(finalAlbumArtUrl);

            delete embed.thumbnail;
            embed.image = { url: 'attachment://cover.png' }; 

            const formData = new FormData();
            formData.append('file', new Blob([imageBuffer]), 'cover.png');
            formData.append('payload_json', JSON.stringify({
                content: `🎉 **Album Highlight from the Top ${TOP_ALBUM_LIMIT}!** 🎉`,
                embeds: [embed],
                components: embedData.components
            }));

            await fetch(`https://discord.com/api/v10/webhooks/${APP_ID}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: formData,
            });
        } else {
            await editInteractionResponse(interaction.token, {
                content: `🎉 **Album Highlight from the Top ${TOP_ALBUM_LIMIT}!** 🎉\n*(A high-res cover image could not be located for this album.)*`,
                embeds: embedData.embeds,
                components: embedData.components
            });
        }

    } catch (error) {
        console.error(`[HIGHLIGHT] Error:`, error);
        await editInteractionResponse(interaction.token, { 
            content: `❌ An internal error occurred while highlighting an album.` 
        });
    }

    return new NextResponse(null, { status: 204 });
}