/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { InteractionResponseType, APIChatInputApplicationCommandInteraction } from 'discord-api-types/v10';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { getTopFeaturedAlbums } from '@/utils/database/feature-service';

export async function handleFeaturedChart(
    interaction: APIChatInputApplicationCommandInteraction,
    waitUntil: (promise: Promise<any>) => void
) {
    // 1. Immediately send the deferral request to Discord
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const processChart = async () => {
        // YIELD THE EVENT LOOP to ensure Vercel flushes the HTTP response back to Discord
        await new Promise((resolve) => setTimeout(resolve, 100));

        try {
            const options = (interaction.data.options || []);
            const rawPage = (options.find(opt => opt.name === 'page') as any)?.value;
            const page = rawPage ? Number(rawPage) : 1;
            
            // Set to 8 to create a taller list as requested
            const limit = 8; 

            const albums = await getTopFeaturedAlbums(page, limit);

            if (!albums || albums.length === 0) {
                await updateResponse(interaction, { content: `No featured albums found on page ${page}.` });
                return;
            }

            const chartBuffer = await createFeaturedListImage(albums, page, limit);

            const formData = new FormData();
            formData.append('file', new Blob([chartBuffer]), 'featured-chart.png');
            
            const pageText = page > 1 ? ` - Page ${page}` : '';
            
            formData.append('payload_json', JSON.stringify({ 
                content: `### 🌟 Top Featured Albums${pageText}` 
            }));

            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH',
                body: formData,
            });

        } catch (error) {
            console.error("Featured Chart Error:", error);
            await updateResponse(interaction, { content: "An error occurred while generating your featured chart." });
        }
    };

    waitUntil(processChart());
    return new NextResponse(null, { status: 204 });
}

async function createFeaturedListImage(albums: any[], page: number, limit: number): Promise<Buffer> {
    const cardWidth = 800;
    const cardHeight = 140;
    const canvasWidth = cardWidth;
    const canvasHeight = Math.max(albums.length * cardHeight, cardHeight);

    const compositeOperations: any[] = [];
    const bg = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

    const cardBg = Buffer.from(`<svg width="${cardWidth}" height="${cardHeight}"><rect x="0" y="5" width="${cardWidth}" height="${cardHeight - 10}" fill="rgba(30,30,30,0.8)" rx="10" ry="10"/></svg>`);
    const maskSvg = Buffer.from(`<svg><rect x="0" y="0" width="120" height="120" rx="15" ry="15" fill="white"/></svg>`);
    const fallbackArt = await sharp({ create: { width: 120, height: 120, channels: 4, background: { r: 50, g: 50, b: 50, alpha: 1 } } })
        .composite([{ input: maskSvg, blend: 'dest-in' }]).png().toBuffer();

    const albumPromises = albums.map(async (album, index) => {
        const top = index * cardHeight;
        
        let roundedArt: Buffer;
        try {
            const url = album.coverArtUrl;
            if (!url) throw new Error("Missing");
            const res = await fetch(url);
            if (!res.ok) throw new Error("Failed");
            const arrayBuffer = await res.arrayBuffer();
            
            roundedArt = await sharp(Buffer.from(arrayBuffer))
                .resize(120, 120)
                .composite([{ input: maskSvg, blend: 'dest-in' }])
                .png().toBuffer();
        } catch {
            roundedArt = fallbackArt; 
        }

        const canvas = createCanvas(cardWidth, cardHeight);
        const ctx = canvas.getContext('2d');
        
        // Album Name
        ctx.fillStyle = 'white';
        ctx.font = 'bold 24px "Courier New", "Noto Sans JP"';
        ctx.textBaseline = 'top';
        const albumName = album.name.length > 35 ? album.name.substring(0, 32) + '...' : album.name;
        ctx.fillText(albumName, 150, 30);

        // Artist Name
        ctx.fillStyle = '#AAAAAA';
        ctx.font = '20px "Courier New", "Noto Sans JP"';
        const artistName = album.artistName.length > 40 ? album.artistName.substring(0, 37) + '...' : album.artistName;
        ctx.fillText(artistName, 150, 65);

        // Score (Points)
        const points = album.featureScore || 0;
        ctx.fillStyle = 'white';
        ctx.font = 'bold 36px "Courier New"';
        ctx.textAlign = 'right';
        ctx.fillText(`${points} pts`, cardWidth - 30, 30);

        // Rating Count
        ctx.fillStyle = '#AAAAAA';
        ctx.font = '16px "Courier New"';
        ctx.fillText(`${album.ratingCount} ratings`, cardWidth - 30, 75);

        // Rank Badge
        const globalRank = album.rank || (((page - 1) * limit) + index + 1);
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; 
        roundRect(ctx, 15, 10, 32, 24, 5);
        ctx.fill();
        
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 14px "Courier New"';
        ctx.fillText(`${globalRank}`, 31, 22);

        return [
            { input: cardBg, left: 0, top },
            { input: roundedArt, left: 15, top: top + 10 },
            { input: canvas.toBuffer('image/png'), left: 0, top }
        ];
    });

    const results = await Promise.all(albumPromises);
    results.flat().forEach(op => compositeOperations.push(op));

    return sharp(bg).composite(compositeOperations).png().toBuffer();
}

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