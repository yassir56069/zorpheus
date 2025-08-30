import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// Define a type for the album data
type Album = {
    name: string;
    artist: {
        name: string;
    };
    image: { '#text': string, size: string }[];
};

// --- FONT LOADING ---
// This part remains the same. We load the font file to embed it.
let fontCss = '';
try {
    const fontPath = path.join(process.cwd(), 'public', 'fonts', 'DejaVuSans.ttf');
    const fontBuffer = fs.readFileSync(fontPath);
    const fontBase64 = fontBuffer.toString('base64');
    fontCss = `
        @font-face {
            font-family: 'DejaVu Sans';
            src: url(data:font/truetype;charset=utf-8;base64,${fontBase64}) format('truetype');
        }
    `;
} catch (error) {
    console.error("Could not load the font file. Make sure 'public/fonts/DejaVuSans.ttf' exists.", error);
}

// --- NEW HELPER FUNCTION ---
/**
 * Generates a transparent PNG buffer containing the provided text.
 * This function isolates the text rendering process.
 * @param text The text to render.
 * @param width The width of the output image.
 * @param height The height of the output image.
 * @param anchor The text-anchor property for SVG ('start', 'middle', 'end').
 * @returns A Promise that resolves with the PNG image Buffer.
 */
async function generateTextBuffer(text: string, width: number, height: number, anchor: 'start' | 'middle' = 'start'): Promise<Buffer> {
    // Helper to escape special XML characters
    const escapeXml = (unsafe: string) => unsafe.replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });

    const sanitizedText = escapeXml(text);
    const x = anchor === 'middle' ? '50%' : '5';

    const svg = `
        <svg width="${width}" height="${height}">
            <defs><style>${fontCss}</style></defs>
            <text x="${x}" y="50%" dominant-baseline="middle" text-anchor="${anchor}" fill="white" font-size="12" font-family="'DejaVu Sans', sans-serif">
                ${sanitizedText}
            </text>
        </svg>
    `;

    return sharp(Buffer.from(svg)).png().toBuffer();
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText} for URL: ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

/**
 * Creates the chart image by compositing album covers and pre-rendered text buffers.
 */
async function createChartImage(albums: Album[], gridWidth: number, gridHeight: number, displayStyle: string): Promise<Buffer> {
    const imageSize = gridWidth > 5 || gridHeight > 5 ? 150 : 300;
    const underTextHeight = displayStyle === 'under' ? 40 : 0;
    const topsterTextWidth = displayStyle === 'topster' ? 250 : 0;

    const canvasWidth = imageSize * gridWidth + topsterTextWidth;
    const canvasHeight = (imageSize + underTextHeight) * gridHeight;

    const canvas = sharp({
        create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 4,
            background: { r: 20, g: 20, b: 20, alpha: 1 }
        }
    });

    const compositeOperations = [];

    // Add black background for Topster style text column
    if (displayStyle === 'topster') {
        const background = await sharp({
            create: { width: topsterTextWidth, height: canvasHeight, channels: 3, background: 'black' }
        }).png().toBuffer();
        compositeOperations.push({ input: background, left: imageSize * gridWidth, top: 0 });
    }

    for (let index = 0; index < albums.length; index++) {
        const album = albums[index];
        const row = Math.floor(index / gridWidth);
        const col = index % gridWidth;
        const left = col * imageSize;
        const top = row * (imageSize + underTextHeight);

        // 1. Composite Album Cover
        try {
            const imageUrl = album.image.find((img) => img.size === 'extralarge')?.['#text'] ||
                             album.image.find((img) => img.size === 'large')?.['#text'] ||
                             'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art';
            const finalImageUrl = imageUrl.includes('/2a96cbd8b46e442fc41c2b86b821562f.png') ? 'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art' : imageUrl;

            const imageBuffer = await fetchImageBuffer(finalImageUrl);
            const resizedImage = await sharp(imageBuffer).resize(imageSize, imageSize).toBuffer();
            compositeOperations.push({ input: resizedImage, left, top });
        } catch (error) {
            console.error(`Failed to process image for ${album.name}:`, error);
            const placeholder = await sharp({ create: { width: imageSize, height: imageSize, channels: 4, background: { r: 50, g: 50, b: 50, alpha: 1 } } }).png().toBuffer();
            compositeOperations.push({ input: placeholder, left, top });
        }

        // 2. Generate and Composite Text (if needed)
        const albumName = `${album.artist.name} - ${album.name}`;

        if (displayStyle === 'under') {
            const truncatedText = albumName.length > 40 ? albumName.substring(0, 37) + '...' : albumName;
            const textBuffer = await generateTextBuffer(truncatedText, imageSize, underTextHeight, 'middle');
            compositeOperations.push({ input: textBuffer, left, top: top + imageSize });
        } else if (displayStyle === 'topster') {
            const truncatedText = albumName.length > 35 ? albumName.substring(0, 32) + '...' : albumName;
            const textBuffer = await generateTextBuffer(truncatedText, topsterTextWidth, imageSize, 'start');
            compositeOperations.push({ input: textBuffer, left: imageSize * gridWidth, top });
        }
    }

    return canvas.composite(compositeOperations).png().toBuffer();
}


/**
 * Handles the logic for the /chart command.
 */
export async function handleChart(interaction: APIChatInputApplicationCommandInteraction) {
    // ... This function remains exactly the same as your last version ...
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const options = (interaction.data.options || []) as APIApplicationCommandInteractionDataStringOption[];
    let lastfmUsername = options.find(opt => opt.name === 'user')?.value || null;

    const sizeOption = options.find(opt => opt.name === 'size')?.value || '3x3';
    const [gridWidth, gridHeight] = sizeOption.split('x').map(Number);
    const limit = gridWidth * gridHeight;
    const displayStyle = options.find(opt => opt.name === 'display_style')?.value || 'no_names';


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
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${lastfmUsername}&period=${period}&api_key=${apiKey}&format=json&limit=${limit}`;

    try {
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.error || !data.topalbums || data.topalbums.album.length < limit) {
            const content = `Could not fetch ${limit} albums for \`${lastfmUsername}\`. They may need to listen to more music to generate a chart for this period.`;
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const albums: Album[] = data.topalbums.album;
        const chartImageBuffer = await createChartImage(albums, gridWidth, gridHeight, displayStyle);

        const formData = new FormData();
        formData.append('file', new Blob([chartImageBuffer]), 'chart.png');

        const periodDisplayNames: { [key: string]: string } = {
            '7day': 'Last 7 Days', '1month': 'Last Month', '3month': 'Last 3 Months',
            '6month': 'Last 6 Months', '12month': 'Last Year', 'overall': 'All Time'
        };
        
        const content = `-# *Top Albums (${periodDisplayNames[period]}) - **${lastfmUsername}***`;
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