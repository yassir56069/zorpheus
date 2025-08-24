import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import sharp from 'sharp';

/**
 * Fetches an image from a URL and returns it as a Buffer.
 * @param url The URL of the image to fetch.
 * @returns A Promise that resolves with the image Buffer.
 */
async function fetchImageBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText} for URL: ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

/**
 * Creates a 3x3 grid image from a list of album cover URLs.
 * @param imageUrls An array of 9 image URLs.
 *_ @returns A Promise that resolves with the generated image Buffer in PNG format.
 */
async function createChartImage(imageUrls: string[]): Promise<Buffer> {
    const imageSize = 300;
    const gridSize = 3;
    const canvasSize = imageSize * gridSize; // Results in a 900x900 image

    const canvas = sharp({
        create: {
            width: canvasSize,
            height: canvasSize,
            channels: 4,
            background: { r: 20, g: 20, b: 20, alpha: 1 }
        }
    });

    const compositeOperations = await Promise.all(
        imageUrls.map(async (url, index) => {
            try {
                const imageBuffer = await fetchImageBuffer(url);
                const resizedImage = await sharp(imageBuffer).resize(imageSize, imageSize).toBuffer();
                return {
                    input: resizedImage,
                    left: (index % gridSize) * imageSize,
                    top: Math.floor(index / gridSize) * imageSize,
                };
            } catch (error) {
                console.error(`Failed to process image ${url}:`, error);
                const placeholder = await sharp({
                    create: {
                        width: imageSize, height: imageSize, channels: 4,
                        background: { r: 50, g: 50, b: 50, alpha: 1 }
                    }
                }).png().toBuffer();
                return {
                    input: placeholder,
                    left: (index % gridSize) * imageSize,
                    top: Math.floor(index / gridSize) * imageSize,
                };
            }
        })
    );

    return canvas.composite(compositeOperations).png().toBuffer();
}

/**
 * Handles the logic for the /chart command.
 */
export async function handleChart(interaction: APIChatInputApplicationCommandInteraction) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const options = (interaction.data.options || []) as APIApplicationCommandInteractionDataStringOption[];
    let lastfmUsername = options.find(opt => opt.name === 'user')?.value || null;

    if (!lastfmUsername) {
        const discordUserId = interaction.member!.user.id;
        lastfmUsername = await kv.get(discordUserId) as string | null;

        if (!lastfmUsername) {
            const content = 'Please register your Last.fm username with `/register` or specify a user in the command.';
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }
    }

    const period = options.find(opt => opt.name === 'period')?.value || '7day';
    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${lastfmUsername}&period=${period}&api_key=${apiKey}&format=json&limit=9`;

    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.topalbums || data.topalbums.album.length < 9) {
            const content = `Could not fetch 9 albums for \`${lastfmUsername}\`. They may need to listen to more music to generate a chart for this period.`;
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const albums = data.topalbums.album;
        // eslint-disable-next-line
        const imageUrls = albums.map((album: { image: any[]; }) =>
            album.image.find((img: { size: string; }) => img.size === 'extralarge')['#text'] ||
            album.image.find((img: { size: string; }) => img.size === 'large')['#text'] ||
            'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art'
        ).map((url: string) =>
            url.includes('/2a96cbd8b46e442fc41c2b86b821562f.png') ? 'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art' : url
        );

        const chartImageBuffer = await createChartImage(imageUrls);

        const formData = new FormData();
        formData.append('file', new Blob([chartImageBuffer]), 'chart.png');

        const periodDisplayNames: { [key: string]: string } = {
            '7day': 'Last 7 Days', '1month': 'Last Month', '3month': 'Last 3 Months',
            '6month': 'Last 6 Months', '12month': 'Last Year', 'overall': 'All Time'
        };
        
        // --- MODIFICATION START ---
        // Instead of an embed, we now create a simple message content string.
        const content = `**${lastfmUsername}'s Top Albums (${periodDisplayNames[period]})**`;

        // We attach the content to the payload_json. The image is sent as a file,
        // so Discord will display it as a large, raw image attachment.
        formData.append('payload_json', JSON.stringify({ content: content }));
        // --- MODIFICATION END ---

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: formData,
        });

    } catch (error) {
        console.error("Chart command error:", error);
        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: JSON.stringify({ content: 'An error occurred while generating your chart.' }),
            headers: { 'Content-Type': 'application/json' },
        });
    }

    return new NextResponse(null, { status: 204 });
}