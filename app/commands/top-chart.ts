/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { InteractionResponseType, APIChatInputApplicationCommandInteraction, APIApplicationCommandInteractionDataStringOption } from 'discord-api-types/v10';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { getTopAlbums } from '@/utils/database/album-service';
import { mapLastFmTagToGenre } from '@/utils/database/genre-service';

export async function handleUnratedTopChart(interaction: APIChatInputApplicationCommandInteraction) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    // Safely get user ID whether they are in a server or DMs
    const userId = (interaction.member?.user?.id || interaction.user?.id) as string;
    if (!userId) {
        await updateResponse(interaction, { content: "⚠️ Could not identify your user ID." });
        return new NextResponse(null, { status: 204 });
    }

    const options = (interaction.data.options || []);
    
    const rawPage = (options.find(opt => opt.name === 'page') as any)?.value;
    const page = rawPage ? Number(rawPage) : 1;

    const sizeOption = (options.find(opt => opt.name === 'size') as APIApplicationCommandInteractionDataStringOption)?.value || '5x5';
    const period = (options.find(opt => opt.name === 'period') as any)?.value;
    
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
        // Fetch Unrated Data passing the user ID!
        const albums = await getTopUnratedAlbums(userId, { page, limit, days, genre: genreToQuery });

        if (!albums || albums.length === 0) {
            const genreText = displayGenre ? `**${displayGenre}** ` : '';
            await updateResponse(interaction, { content: `No unrated ${genreText}albums found for you on page ${page}. You've heard them all!` });
            return new NextResponse(null, { status: 204 });
        }

        // We can safely reuse the existing image generator
        const chartBuffer = await createRankedChartImage(albums, gridWidth, gridHeight, page, limit);

        const formData = new FormData();
        formData.append('file', new Blob([chartBuffer]), 'unrated-chart.png');
        
        const baseTitle = displayGenre ? `Top Unrated ${displayGenre} Albums` : `Top Unrated Albums`;
        const timePeriodTitle = period ? `${baseTitle} (${period})` : `${baseTitle} (All Time)`;
        const pageText = page > 1 ? ` - Page ${page}` : '';
        
        formData.append('payload_json', JSON.stringify({ 
            content: `### 🎧 ${timePeriodTitle}${pageText}\n*(Highly rated server albums you haven't reviewed yet!)*` 
        }));

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH',
            body: formData,
        });

    } catch (error) {
        console.error("Unrated Chart Error:", error);
        await updateResponse(interaction, { content: "An error occurred while generating your chart. The grid might be too large." });
    }

    return new NextResponse(null, { status: 204 });
}


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
    
    const[gridWidth, gridHeight] = sizeOption.split('x').map(Number);
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
    const imageSize = (gridWidth * gridHeight) > 25 ? 200 : 300; 
    
    const canvasWidth = imageSize * gridWidth;
    const canvasHeight = imageSize * gridHeight;

    const compositeOperations: any[] =[];

    // Process all albums in parallel
    const albumPromises = albums.map(async (album, index) => {
        const row = Math.floor(index / gridWidth);
        const col = index % gridWidth;
        const left = col * imageSize;
        const top = row * imageSize;

        const globalRank = album.serverRank || (((page - 1) * limit) + index + 1);

        let albumArt: Buffer;
        let isMissingArt = false;
        
        try {
            // Check for valid URL instead of using generic placeholder, so we can trigger custom fallback
            const url = album.coverArtUrl; 
            if (!url) throw new Error("Missing Art URL");
            
            const res = await fetch(url);
            if (!res.ok) throw new Error("Failed to fetch art");
            
            const arrayBuffer = await res.arrayBuffer();
            albumArt = await sharp(Buffer.from(arrayBuffer))
                .resize(imageSize, imageSize)
                .toBuffer();
        } catch {
            isMissingArt = true;
            // Create a fully grey tile as requested
            albumArt = await sharp({ 
                create: { width: imageSize, height: imageSize, channels: 4, background: { r: 35, g: 35, b: 35, alpha: 1 } } 
            }).png().toBuffer();
        }

        const badgeCanvas = createCanvas(imageSize, imageSize);
        const ctx = badgeCanvas.getContext('2d');
        
        // --- MISSING ART TEXT ---
        if (isMissingArt) {
            // Defensively check common property names depending on your DB schema
            const artist = album.artist || album.artistName || 'Unknown Artist';
            const title = album.name || album.title || album.album || 'Unknown Album';
            drawMissingAlbumText(ctx, `${artist} - ${title}`, imageSize);
        }

        const score = Number((album.weightedScore || album.avgScore) / 2).toFixed(2);
        
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
        ctx.textBaseline = 'alphabetic';
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

        return[
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
    .png({ quality: 80, compressionLevel: 9 })
    .toBuffer();
}

// Automatically wraps and scales text to fit gracefully onto an empty square
function drawMissingAlbumText(ctx: any, text: string, imageSize: number) {
    const padding = 15;
    const maxWidth = imageSize - padding * 2;
    const maxHeight = imageSize - padding * 2;
    
    let fontSize = Math.floor(imageSize / 8); 
    let lines: string[] =[];
    let lineHeight = 0;

    // Word wrap and dynamic resizing
    while (fontSize > 10) {
        ctx.font = `bold ${fontSize}px "Courier New"`;
        const words = text.split(' ');
        let currentLine = words[0] || '';
        lines =[];

        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const width = ctx.measureText(currentLine + " " + word).width;
            if (width < maxWidth) {
                currentLine += " " + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        lines.push(currentLine);

        lineHeight = fontSize * 1.3;
        const totalHeight = lines.length * lineHeight;
        const maxLineWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
        
        // If it fits within the square bounds, stop scaling
        if (totalHeight <= maxHeight && maxLineWidth <= maxWidth) {
            break; 
        }
        fontSize -= 2;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const totalHeight = lines.length * lineHeight;
    let startY = (imageSize - totalHeight) / 2 + (lineHeight / 2);

    lines.forEach(line => {
        // Draw a slight shadow to make text pop against the grey tile
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillText(line, (imageSize / 2) + 2, startY + 2);
        
        ctx.fillStyle = '#DDDDDD';
        ctx.fillText(line, imageSize / 2, startY);
        
        startY += lineHeight;
    });
}

// Helper for rounded rectangles
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