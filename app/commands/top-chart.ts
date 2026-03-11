/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { InteractionResponseType, APIChatInputApplicationCommandInteraction, APIApplicationCommandInteractionDataStringOption } from 'discord-api-types/v10';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { getTopAlbums } from '@/utils/database/album-service';
import { mapLastFmTagToGenre } from '@/utils/database/genre-service';

export async function handleTopChart(interaction: APIChatInputApplicationCommandInteraction) {
    // 1. Defer the interaction immediately
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const options = (interaction.data.options ||[]);
    
    const rawPage = (options.find(opt => opt.name === 'page') as any)?.value;
    const page = rawPage ? Number(rawPage) : 1;

    const sizeOption = (options.find(opt => opt.name === 'size') as APIApplicationCommandInteractionDataStringOption)?.value || '5x5';
    const period = (options.find(opt => opt.name === 'period') as any)?.value;
    
    // --- NEW: Extract and parse Genre Option ---
    const rawGenre = (options.find(opt => opt.name === 'genre') as APIApplicationCommandInteractionDataStringOption)?.value;
    let genreToQuery: string | undefined;
    let displayGenre = '';

    if (rawGenre) {
        const mappedGenre = mapLastFmTagToGenre(rawGenre);
        if (!mappedGenre) {
            await updateResponse(interaction, { content: `⚠️ I couldn't map \`${rawGenre}\` to a valid database genre. Please try a different genre.` });
            return new NextResponse(null, { status: 204 });
        }
        genreToQuery = mappedGenre;
        
        // Formats "post-punk" -> "Post-Punk" / "hip hop" -> "Hip Hop" for the chart title
        displayGenre = mappedGenre
            .split(' ')
            .map(w => w.split('-').map(x => x.charAt(0).toUpperCase() + x.slice(1)).join('-'))
            .join(' ');
    }
    
    const [gridWidth, gridHeight] = sizeOption.split('x').map(Number);
    const limit = gridWidth * gridHeight;

    const daysMap: Record<string, number> = { 'week': 7, 'month': 30, 'year': 365 };
    const days = period ? daysMap[period] : undefined;

    try {
        // 2. Fetch data from Turso with the dynamic page AND genre filter
        const albums = await getTopAlbums({ page, limit, days, genre: genreToQuery });

        if (!albums || albums.length === 0) {
            const genreText = displayGenre ? `**${displayGenre}** ` : '';
            await updateResponse(interaction, { content: `No rated ${genreText}albums found for page ${page}.` });
            return new NextResponse(null, { status: 204 });
        }

        // 3. Generate the chart
        const chartBuffer = await createRankedChartImage(albums, gridWidth, gridHeight, page, limit);

        // 4. Send back to Discord
        const formData = new FormData();
        formData.append('file', new Blob([chartBuffer]), 'top-chart.png');
        
        // Dynamically build a beautiful Title
        const baseTitle = displayGenre ? `Top Rated ${displayGenre} Albums` : `Top Rated Albums`;
        const timePeriodTitle = period ? `${baseTitle} (${period})` : `${baseTitle} (All Time)`;
        const pageText = page > 1 ? ` - Page ${page}` : '';
        
        formData.append('payload_json', JSON.stringify({ 
            content: `### 🏆 ${timePeriodTitle}${pageText}` 
        }));

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: formData,
        });

    } catch (error) {
        console.error("Top Chart Error:", error);
        await updateResponse(interaction, { content: "An error occurred while generating the chart. The grid might be too large for the server to process in time." });
    }

    return new NextResponse(null, { status: 204 });
}

/**
 * Creates a chart image with rating overlays
 */
async function createRankedChartImage(
    albums: any[], 
    gridWidth: number, 
    gridHeight: number, 
    page: number, 
    limit: number
): Promise<Buffer> {
    // OPTIMIZATION: If the grid is massive (e.g. 10x10), reduce tile size to save memory/bandwidth
    // 300px * 10 = 3000px (Very heavy). 200px * 10 = 2000px (Manageable).
    const imageSize = (gridWidth * gridHeight) > 25 ? 200 : 300; 
    
    const canvasWidth = imageSize * gridWidth;
    const canvasHeight = imageSize * gridHeight;

    const compositeOperations: any[] = [];

    // Process all albums in parallel
    const albumPromises = albums.map(async (album, index) => {
        const row = Math.floor(index / gridWidth);
        const col = index % gridWidth;
        const left = col * imageSize;
        const top = row * imageSize;

        // Calculate actual rank: (previous pages * items per page) + current index + 1
        const globalRank = ((page - 1) * limit) + index + 1;

        let albumArt: Buffer;
        try {
            const url = album.coverArtUrl || 'https://via.placeholder.com/300/141414/FFFFFF?text=No+Art';
            const res = await fetch(url);
            const arrayBuffer = await res.arrayBuffer();
            // Resize immediately to target imageSize to save memory
            albumArt = await sharp(Buffer.from(arrayBuffer))
                .resize(imageSize, imageSize)
                .toBuffer();
        } catch {
            albumArt = await sharp({ 
                create: { width: imageSize, height: imageSize, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } } 
            }).png().toBuffer();
        }

        const badgeCanvas = createCanvas(imageSize, imageSize);
        const ctx = badgeCanvas.getContext('2d');
        const score = Number(album.avgScore / 2).toFixed(2);
        
        // --- SCORE BADGE (Bottom Right) ---
        ctx.font = `bold ${Math.floor(imageSize/12)}px "Courier New"`;
        const textMetrics = ctx.measureText(score);
        const badgeWidth = textMetrics.width + 14;
        const badgeHeight = imageSize / 8;
        const bx = imageSize - badgeWidth - 5;
        const by = imageSize - badgeHeight - 5;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        roundRect(ctx, bx, by, badgeWidth, badgeHeight, 5);
        ctx.fill();

        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.fillText(score, bx + badgeWidth / 2, by + (badgeHeight * 0.7));

        // --- RANK BADGE (Top Left) ---
        const rankSize = imageSize / 7;
        ctx.fillStyle = 'rgba(255, 215, 0, 0.9)'; 
        roundRect(ctx, 5, 5, rankSize * 1.2, rankSize, 3);
        ctx.fill();
        
        ctx.fillStyle = 'black';
        ctx.font = `bold ${Math.floor(rankSize * 0.6)}px "Courier New"`;
        ctx.fillText(`${globalRank}`, 5 + (rankSize * 0.6), 5 + (rankSize * 0.7));

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
    .png({ quality: 80, compressionLevel: 9 }) // Compression helps Discord upload limits
    .toBuffer();
}

// Helper for rounded rectangles (No changes needed)
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

async function updateResponse(interaction: any, data: any) {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
}