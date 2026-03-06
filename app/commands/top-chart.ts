import { NextResponse } from 'next/server';
import { InteractionResponseType, APIChatInputApplicationCommandInteraction, APIApplicationCommandInteractionDataStringOption } from 'discord-api-types/v10';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { getTopAlbums } from '@/utils/database/album-service';

export async function handleTopChart(interaction: APIChatInputApplicationCommandInteraction) {
    // 1. Defer the interaction immediately
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const options = (interaction.data.options || []);
    const sizeOption = (options.find(opt => opt.name === 'size') as APIApplicationCommandInteractionDataStringOption)?.value || '3x3';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const period = (options.find(opt => opt.name === 'period') as any)?.value;
    
    const [gridWidth, gridHeight] = sizeOption.split('x').map(Number);
    const limit = gridWidth * gridHeight;

    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    try {
        // 2. Fetch data from Turso
        const albums = await getTopAlbums({ page: 1, limit, days });

        if (!albums || albums.length === 0) {
            await updateResponse(interaction, { content: "No rated albums found in the database." });
            return new NextResponse(null, { status: 204 });
        }

        // 3. Generate the chart
        const chartBuffer = await createRankedChartImage(albums, gridWidth, gridHeight);

        // 4. Send back to Discord
        const formData = new FormData();
        formData.append('file', new Blob([chartBuffer]), 'top-chart.png');
        
        const title = period ? `Top Rated Albums (Last ${period})` : `Top Rated Albums (All Time)`;
        formData.append('payload_json', JSON.stringify({ content: `### 🏆 ${title}` }));

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: formData,
        });

    } catch (error) {
        console.error("Top Chart Error:", error);
        await updateResponse(interaction, { content: "An error occurred while generating the chart." });
    }

    return new NextResponse(null, { status: 204 });
}

/**
 * Creates a chart image with rating overlays
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createRankedChartImage(albums: any[], gridWidth: number, gridHeight: number): Promise<Buffer> {
    const imageSize = 300; // Standard size
    const canvasWidth = imageSize * gridWidth;
    const canvasHeight = imageSize * gridHeight;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compositeOperations: any[] = [];

    // Process all albums in parallel to speed up serverless execution
    const albumPromises = albums.map(async (album, index) => {
        const row = Math.floor(index / gridWidth);
        const col = index % gridWidth;
        const left = col * imageSize;
        const top = row * imageSize;

        let albumArt: Buffer;
        try {
            const url = album.coverArtUrl || 'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art';
            const res = await fetch(url);
            const arrayBuffer = await res.arrayBuffer();
            albumArt = await sharp(Buffer.from(arrayBuffer)).resize(imageSize, imageSize).toBuffer();
        } catch {
            albumArt = await sharp({ create: { width: imageSize, height: imageSize, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
        }

        // Create the Rating Badge Overlay using Canvas
        const badgeCanvas = createCanvas(imageSize, imageSize);
        const ctx = badgeCanvas.getContext('2d');
        
        const score = Number(album.weightedScore).toFixed(2);
        
        // Background Pill for score (Bottom Right)
        const padding = 8;
        ctx.font = 'bold 24px "Courier New"';
        const textMetrics = ctx.measureText(score);
        const badgeWidth = textMetrics.width + 20;
        const badgeHeight = 40;
        const bx = imageSize - badgeWidth - 10;
        const by = imageSize - badgeHeight - 10;

        // Draw semi-transparent background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        roundRect(ctx, bx, by, badgeWidth, badgeHeight, 8);
        ctx.fill();

        // Draw score text
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.fillText(score, bx + badgeWidth / 2, by + 28);

        // Draw Rank Badge (Top Left)
        ctx.fillStyle = 'rgba(255, 215, 0, 0.9)'; // Gold-ish
        roundRect(ctx, 10, 10, 40, 40, 5);
        ctx.fill();
        ctx.fillStyle = 'black';
        ctx.font = 'bold 20px "Courier New"';
        ctx.fillText(`${index + 1}`, 30, 37);

        const badgeBuffer = badgeCanvas.toBuffer('image/png');

        return [
            { input: albumArt, left, top },
            { input: badgeBuffer, left, top }
        ];
    });

    const results = await Promise.all(albumPromises);
    results.flat().forEach(op => compositeOperations.push(op));

    return sharp({
        create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 4,
            background: { r: 15, g: 15, b: 15, alpha: 1 }
        }
    })
    .composite(compositeOperations)
    .png()
    .toBuffer();
}

// Helper for rounded rectangles in Canvas
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function roundRect(ctx: any, x: number, y: number, width: number, height: number, radius: number) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateResponse(interaction: any, data: any) {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
}