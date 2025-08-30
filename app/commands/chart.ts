import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import sharp from 'sharp';

// Define a type for the album data we need
type Album = {
    name: string;
    artist: {
        name: string;
    };
    image: { '#text': string, size: string }[];
};


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
 * @param albums An array of album objects from the Last.fm API.
 * @param gridWidth The number of images per row.
 * @param gridHeight The number of rows.
 * @param displayStyle The style to display album names ('no_names', 'topster', 'under').
 * @returns A Promise that resolves with the generated image Buffer in PNG format.
 */
async function createChartImage(albums: Album[], gridWidth: number, gridHeight: number, displayStyle: string): Promise<Buffer> {
    const imageSize = gridWidth > 5 || gridHeight > 5 ? 150 : 300;
    const textHeight = displayStyle === 'under' ? 40 : 0;
    const topsterTextWidth = displayStyle === 'topster' ? 300 : 0;

    const canvasWidth = imageSize * gridWidth + topsterTextWidth;
    const canvasHeight = (imageSize + textHeight) * gridHeight;

    const canvas = sharp({
        create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 4,
            background: { r: 20, g: 20, b: 20, alpha: 1 }
        }
    });

    const compositeOperations = [];

    // Add black background for Topster style text
    if (displayStyle === 'topster') {
        compositeOperations.push({
            input: Buffer.from(
                `<svg width="${topsterTextWidth}" height="${canvasHeight}">
                    <rect x="0" y="0" width="${topsterTextWidth}" height="${canvasHeight}" fill="black" />
                </svg>`
            ),
            left: canvasWidth - topsterTextWidth,
            top: 0
        });
    }


    for (let index = 0; index < albums.length; index++) {
        const album = albums[index];
        const row = Math.floor(index / gridWidth);
        const col = index % gridWidth;
        const left = col * imageSize;
        const top = row * (imageSize + textHeight);

        // Fetch and composite album cover
        try {
            const imageUrl = album.image.find((img) => img.size === 'extralarge')?.['#text'] ||
                             album.image.find((img) => img.size === 'large')?.['#text'] ||
                             'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art';
            
            const finalImageUrl = imageUrl.includes('/2a96cbd8b46e442fc41c2b86b821562f.png') ? 'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art' : imageUrl;


            const imageBuffer = await fetchImageBuffer(finalImageUrl);
            const resizedImage = await sharp(imageBuffer).resize(imageSize, imageSize).toBuffer();
            compositeOperations.push({
                input: resizedImage,
                left: left,
                top: top,
            });
        } catch (error) {
            console.error(`Failed to process image for ${album.name}:`, error);
            const placeholder = await sharp({
                create: {
                    width: imageSize, height: imageSize, channels: 4,
                    background: { r: 50, g: 50, b: 50, alpha: 1 }
                }
            }).png().toBuffer();
            compositeOperations.push({
                input: placeholder,
                left: left,
                top: top,
            });
        }

        // Add text based on display style
        const albumName = `${album.artist.name} - ${album.name}`.replace(/&/g, '&amp;');

        if (displayStyle === 'under') {
            const svgText = `
                <svg width="${imageSize}" height="${textHeight}">
                    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="white" font-size="14" font-family="sans-serif">
                        ${albumName}
                    </text>
                </svg>`;
            compositeOperations.push({
                input: Buffer.from(svgText),
                left: left,
                top: top + imageSize,
            });
        } else if (displayStyle === 'topster' && col === gridWidth - 1) {
             const rowAlbums = albums.slice(row * gridWidth, (row + 1) * gridWidth);
             const textBlock = rowAlbums.map(a => `${a.artist.name} - ${a.name}`.replace(/&/g, '&amp;')).join('<br/>');

            const svgTextBlock = `
                <svg width="${topsterTextWidth}" height="${imageSize}">
                    <text x="10" y="20" fill="white" font-size="14" font-family="sans-serif">
                        ${textBlock.split('<br/>').map((line, i) => `<tspan x="10" dy="${i === 0 ? 0 : '1.2em'}">${line}</tspan>`).join('')}
                    </text>
                </svg>`;
            
            compositeOperations.push({
                input: Buffer.from(svgTextBlock),
                left: canvasWidth - topsterTextWidth,
                top: row * imageSize,
            });
        }
    }

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

        // Generate the chart with the specified dimensions and display style
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