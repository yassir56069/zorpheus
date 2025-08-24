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
    // --- MODIFICATION START ---
    const imageSize = 500; // Changed from 300 to 500 for a 1500x1500 total image size
    // --- MODIFICATION END ---
    const gridSize = 3;
    const canvasSize = imageSize * gridSize;

    // Create a blank canvas
    const canvas = sharp({
        create: {
            width: canvasSize,
            height: canvasSize,
            channels: 4,
            background: { r: 20, g: 20, b: 20, alpha: 1 } // A dark background
        }
    });

    // Prepare all 9 images for composition
    const compositeOperations = await Promise.all(
        imageUrls.map(async (url, index) => {
            try {
                // Fetch the image
                const imageBuffer = await fetchImageBuffer(url);
                // Resize it to fit the grid cell
                const resizedImage = await sharp(imageBuffer)
                    .resize(imageSize, imageSize)
                    .toBuffer();

                // Return the operation for the composite function
                return {
                    input: resizedImage,
                    left: (index % gridSize) * imageSize,
                    top: Math.floor(index / gridSize) * imageSize,
                };
            } catch (error) {
                console.error(`Failed to process image ${url}:`, error);
                // If an image fails, create a dark grey placeholder
                const placeholder = await sharp({
                    create: {
                        width: imageSize,
                        height: imageSize,
                        channels: 4,
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

    // Composite all images onto the canvas and return the final image as a Buffer
    return canvas.composite(compositeOperations).png().toBuffer();
}

/**
 * Handles the logic for the /chart command.
 */
export async function handleChart(interaction: APIChatInputApplicationCommandInteraction) {
    // Immediately defer the reply, as fetching and processing images can take time
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const options = (interaction.data.options || []) as APIApplicationCommandInteractionDataStringOption[];
    const period = options.find(opt => opt.name === 'period')?.value || '7day';
    let lastfmUsername = options.find(opt => opt.name === 'user')?.value || null;

    // If no username is provided in the command, use the registered one
    if (!lastfmUsername) {
        const discordUserId = interaction.member!.user.id;
        lastfmUsername = await kv.get(discordUserId) as string | null;

        if (!lastfmUsername) {
            const content = 'Please register your Last.fm username with `/register` or specify a user in the command.';
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content }),
                headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }
    }

    const apiKey = process.env.LASTFM_API_KEY;
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${lastfmUsername}&period=${period}&api_key=${apiKey}&format=json&limit=9`;

    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.topalbums || data.topalbums.album.length < 9) {
            const content = `Could not fetch 9 albums for \`${lastfmUsername}\`. They may need to listen to more music to generate a chart for this period.`;
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: JSON.stringify({ content }),
                headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const albums = data.topalbums.album;
        // eslint-disable-next-line
        const imageUrls = albums.map((album: { image: any[]; }) =>
            album.image.find((img: { size: string; }) => img.size === 'extralarge')['#text'] ||
            album.image.find((img: { size: string; }) => img.size === 'large')['#text'] ||
            // Fallback for missing images
            'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art'
        ).map((url: string) =>
            // Replace the default Last.fm placeholder with our custom one
            url.includes('/2a96cbd8b46e442fc41c2b86b821562f.png') ? 'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art' : url
        );

        // Generate the chart image
        const chartImageBuffer = await createChartImage(imageUrls);

        // Use FormData to upload the image file to Discord
        const formData = new FormData();
        formData.append('file', new Blob([chartImageBuffer]), 'chart.png');

        const discordUser = interaction.member!.user;
        const periodDisplayNames: { [key: string]: string } = {
            '7day': 'Last 7 Days',
            '1month': 'Last Month',
            '3month': 'Last 3 Months',
            '6month': 'Last 6 Months',
            '12month': 'Last Year',
            'overall': 'All Time'
        };
        
        const embed = {
            image: {
                url: 'attachment://chart.png', // Tell Discord to use the attached file
            },
            footer: {
                text: `${lastfmUsername}'s Top Albums (${periodDisplayNames[period]}) • Requested by ${discordUser.username}`,
                icon_url: `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
            }
        };

        formData.append('payload_json', JSON.stringify({ embeds: [embed] }));

        // Send the final response with the image
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