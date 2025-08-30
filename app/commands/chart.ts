import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import sharp from 'sharp';
import path from 'path';
import { createCanvas, registerFont } from 'canvas';

// --- FONT REGISTRATION ---
try {
    // --- CHANGE: Using Courier New font file. Make sure 'cour.ttf' is in public/fonts/ ---
    const fontPath = path.join(process.cwd(), 'public', 'fonts', 'cour.ttf');
    // We can still use the 'family' name 'Courier New' for consistency in the code.
    registerFont(fontPath, { family: 'Courier New' });
    console.log("Font 'cour.ttf' (Courier New) registered successfully with node-canvas.");
} catch (error)
 {
    console.error("CRITICAL: Could not register the font. Make sure 'public/fonts/cour.ttf' exists.", error);
}

// Define a type for the album data
type Album = {
    name: string;
    artist: {
        name: string;
    };
    image: { '#text': string, size: string }[];
};

/**
 * --- MODIFIED FUNCTION ---
 * Now accepts font size and line height to allow for dynamic text rendering.
 */
async function generateTextBuffer(
    texts: string[],
    width: number,
    height: number,
    anchor: 'start' | 'center' | 'end' = 'start',
    fontSize: number,
    lineHeight: number
): Promise<Buffer> {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // --- CHANGE: Font properties are now dynamic based on passed parameters ---
    ctx.font = `bold ${fontSize}px "Courier New"`;
    ctx.fillStyle = 'white';
    ctx.textAlign = anchor;
    ctx.textBaseline = 'top';
    
    let startY = 15;

    let x;
    if (anchor === 'center') {
        x = width / 2;
    } else { // 'start'
        x = 10;
    }
    
    texts.forEach(text => {
        ctx.fillText(text, x, startY);
        startY += lineHeight;
    });

    return canvas.toBuffer('image/png');
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
 * --- MODIFIED FUNCTION ---
 * Determines font size, line height, and character limits based on grid dimensions.
 */
async function createChartImage(albums: Album[], gridWidth: number, gridHeight: number, displayStyle: string): Promise<Buffer> {
    const imageSize = gridWidth > 8 || gridHeight > 8 ? 150 : 300; // Adjusted trigger for smaller images
    const underTextHeight = displayStyle === 'under' ? 40 : 0;
    const topsterTextWidth = displayStyle === 'topster' ? 450 : 0;

    // --- NEW: Dynamic text property logic ---
    let fontSize, lineHeight, charLimit;
    // Check for dense charts that use the smaller image size
    if (imageSize === 150) {
        fontSize = 11; // Smaller font for dense charts
        lineHeight = 15; // Tighter line spacing
        charLimit = 60; // More characters can fit
        console.log(`Dense chart detected (${gridWidth}x${gridHeight}). Using smaller font size.`);
    } else {
        fontSize = 14; // Standard font size
        lineHeight = 22;
        charLimit = 48; // Standard character limit
    }
    // --- END NEW ---

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

    // Part 1: Composite album covers and 'under' style text
    for (let index = 0; index < albums.length; index++) {
        const album = albums[index];
        const row = Math.floor(index / gridWidth);
        const col = index % gridWidth;
        const left = col * imageSize;
        const top = row * (imageSize + underTextHeight);

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

        if (displayStyle === 'under') {
            const albumName = `${album.artist.name} - ${album.name}`;
            const truncatedText = albumName.length > 40 ? albumName.substring(0, 37) + '...' : albumName;
            // Pass dynamic text properties
            const textBuffer = await generateTextBuffer([truncatedText], imageSize, underTextHeight, 'center', fontSize, lineHeight);
            compositeOperations.push({ input: textBuffer, left, top: top + imageSize });
        }
    }

    // Part 2: Handle 'topster' style text
    if (displayStyle === 'topster') {
        const background = await sharp({ create: { width: topsterTextWidth, height: canvasHeight, channels: 3, background: 'black' } }).png().toBuffer();
        compositeOperations.push({ input: background, left: imageSize * gridWidth, top: 0 });

        for (let row = 0; row < gridHeight; row++) {
            const rowAlbums = albums.slice(row * gridWidth, (row + 1) * gridWidth);
            
            const albumNames = rowAlbums.map(album => {
                const fullName = `${album.artist.name} - ${album.name}`;
                // Use dynamic character limit
                return fullName.length > charLimit ? fullName.substring(0, charLimit - 3) + '...' : fullName;
            });

            // Pass dynamic text properties
            const textBuffer = await generateTextBuffer(albumNames, topsterTextWidth, imageSize, 'start', fontSize, lineHeight);
            const top = row * (imageSize + underTextHeight);
            compositeOperations.push({ input: textBuffer, left: imageSize * gridWidth, top });
        }
    }

    return canvas.composite(compositeOperations).png().toBuffer();
}


/**
 * Handles the logic for the /chart command.
 * THIS FUNCTION REMAINS UNCHANGED.
 */
export async function handleChart(interaction: APIChatInputApplicationCommandInteraction) {
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