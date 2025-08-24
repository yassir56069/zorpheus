import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import sharp from 'sharp';

async function fetchImageBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText} for URL: ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

/**
 * Creates a dynamic grid image from a list of album cover URLs.
 * @param imageUrls An array of image URLs.
 * @param gridWidth The number of images per row.
 * @param gridHeight The number of rows.
 * @returns A Promise that resolves with the generated image Buffer in PNG format.
 */
async function createChartImage(imageUrls: string[], gridWidth: number, gridHeight: number): Promise<Buffer> {
    // Dynamically adjust image size for larger grids to avoid huge file sizes
    const imageSize = gridWidth > 5 || gridHeight > 5 ? 150 : 300;

    const canvasWidth = imageSize * gridWidth;
    const canvasHeight = imageSize * gridHeight;

    const canvas = sharp({
        create: {
            width: canvasWidth,
            height: canvasHeight,
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
                    left: (index % gridWidth) * imageSize,
                    top: Math.floor(index / gridWidth) * imageSize,
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
                    left: (index % gridWidth) * imageSize,
                    top: Math.floor(index / gridWidth) * imageSize,
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

    // --- MODIFICATION START ---
    // Parse the new 'size' option
    const sizeOption = options.find(opt => opt.name === 'size')?.value || '3x3';
    const [gridWidth, gridHeight] = sizeOption.split('x').map(Number);
    const limit = gridWidth * gridHeight;
    // --- MODIFICATION END ---

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
    // Update the API URL to fetch the correct number of albums
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${lastfmUsername}&period=${period}&api_key=${apiKey}&format=json&limit=${limit}`;

    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        // Check if we got enough albums for the requested chart size
        if (data.error || !data.topalbums || data.topalbums.album.length < limit) {
            const content = `Could not fetch ${limit} albums for \`${lastfmUsername}\`. They may need to listen to more music to generate a chart for this period.`;
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const albums = data.topalbums.album;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imageUrls = albums.map((album: { image: any[]; }) =>
            album.image.find((img) => img.size === 'extralarge')['#text'] ||
            album.image.find((img) => img.size === 'large')['#text'] ||
            'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art'
        ).map((url: string) =>
            url.includes('/2a96cbd8b46e442fc41c2b86b821562f.png') ? 'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art' : url
        );

        // Generate the chart with the specified dimensions
        const chartImageBuffer = await createChartImage(imageUrls, gridWidth, gridHeight);

        const formData = new FormData();
        formData.append('file', new Blob([chartImageBuffer]), 'chart.png');

        const periodDisplayNames: { [key: string]: string } = {
            '7day': 'Last 7 Days', '1month': 'Last Month', '3month': 'Last 3 Months',
            '6month': 'Last 6 Months', '12month': 'Last Year', 'overall': 'All Time'
        };
        
        const content = `-# *Top Albums (${periodDisplayNames[period]}) - ${lastfmUsername}**`;
        formData.append('payload_json', JSON.stringify({ content: content }));

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