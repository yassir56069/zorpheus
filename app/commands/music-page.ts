import { APIChatInputApplicationCommandInteraction, InteractionResponseType, APIApplicationCommandInteractionDataStringOption, APIApplicationCommandInteractionDataUserOption, APIApplicationCommandInteractionDataNumberOption, ComponentType, APIMessageComponentButtonInteraction } from 'discord-api-types/v10';
import { NextResponse } from 'next/server';
import { getMusicPageAlbums, saveMusicPageSession, getMusicPageSession, getMusicPageImage, saveMusicPageImage, MusicPageOptions } from '@/utils/database/music-page-service';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { mapLastFmTagToGenre } from '@/utils/database/genre-service';

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

export async function createMusicPageImage(albums: any[], page: number, limit: number): Promise<Buffer> {
    const cardWidth = 800;
    const cardHeight = 140;
    const canvasWidth = cardWidth;
    const canvasHeight = Math.max(albums.length * cardHeight, cardHeight);

    const compositeOperations: any[] = [];
    
    const bg = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

    const albumPromises = albums.map(async (album, index) => {
        const top = index * cardHeight;
        
        // Semi-transparent aesthetic card backing
        const cardBg = Buffer.from(`<svg width="${cardWidth}" height="${cardHeight}">
            <rect x="0" y="5" width="${cardWidth}" height="${cardHeight - 10}" fill="rgba(30,30,30,0.8)" rx="10" ry="10"/>
        </svg>`);
        
        let albumArt: Buffer;
        try {
            const url = album.coverArtUrl;
            if (!url) throw new Error("Missing");
            const res = await fetch(url);
            if (!res.ok) throw new Error("Failed");
            const arrayBuffer = await res.arrayBuffer();
            albumArt = await sharp(Buffer.from(arrayBuffer)).resize(120, 120).png().toBuffer();
        } catch {
            albumArt = await sharp({ create: { width: 120, height: 120, channels: 4, background: { r: 50, g: 50, b: 50, alpha: 1 } } }).png().toBuffer();
        }

        const roundedArt = await sharp(albumArt)
            .composite([{
                input: Buffer.from(`<svg><rect x="0" y="0" width="120" height="120" rx="15" ry="15" fill="white"/></svg>`),
                blend: 'dest-in'
            }])
            .png().toBuffer();

        const canvas = createCanvas(cardWidth, cardHeight);
        const ctx = canvas.getContext('2d');

        // Render card information
        ctx.fillStyle = 'white';
        ctx.font = 'bold 24px "Courier New", "Noto Sans JP"';
        ctx.textBaseline = 'top';
        const albumName = album.name.length > 35 ? album.name.substring(0, 32) + '...' : album.name;
        ctx.fillText(albumName, 150, 30);

        ctx.fillStyle = '#AAAAAA';
        ctx.font = '20px "Courier New", "Noto Sans JP"';
        const artistName = album.artistName.length > 40 ? album.artistName.substring(0, 37) + '...' : album.artistName;
        ctx.fillText(artistName, 150, 65);

        const score = Number(album.weightedScore / 2).toFixed(2); 
        ctx.fillStyle = 'white';
        ctx.font = 'bold 36px "Courier New"';
        ctx.textAlign = 'right';
        ctx.fillText(score, cardWidth - 30, 30);

        ctx.fillStyle = '#AAAAAA';
        ctx.font = '16px "Courier New"';
        ctx.fillText(`${album.ratingCount} ratings`, cardWidth - 30, 75);

        // Standard Rank Badge (Top Left Corner of the Album Card)
        const globalRank = ((page - 1) * limit) + index + 1;
        ctx.fillStyle = 'rgba(255, 215, 0, 0.9)'; 
        roundRect(ctx, 10, 10, 35, 35, 5);
        ctx.fill();
        ctx.fillStyle = 'black';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 18px "Courier New"';
        ctx.fillText(`${globalRank}`, 27, 27);

        const badgeBuffer = canvas.toBuffer('image/png');

        return [
            { input: cardBg, left: 0, top },
            { input: roundedArt, left: 15, top: 10 },
            { input: badgeBuffer, left: 0, top }
        ];
    });

    const results = await Promise.all(albumPromises);
    results.flat().forEach(op => compositeOperations.push(op));

    return sharp(bg)
        .composite(compositeOperations)
        .png()
        .toBuffer();
}

async function updateResponse(appId: string, token: string, data: any) {
    await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
}

async function sendMusicPageResponse(appId: string, token: string, sessionId: string, page: number, params: MusicPageOptions) {
    const cacheKey = `${sessionId}:${page}`;
    let imageBuffer = await getMusicPageImage(cacheKey);
    let hasNext = true;
    const limit = 5;

    // Utilize fallback execution if limit hasn't cached an image for this instance yet 
    if (!imageBuffer) {
        const albums = await getMusicPageAlbums(params, page, limit + 1); // +1 grabs one from the next page to confirm hasNext availability without secondary queries. 
        
        if (albums.length === 0) {
            await updateResponse(appId, token, { content: `No albums found for your query parameters on page ${page}.`, components: [] });
            return;
        }

        hasNext = albums.length > limit;
        const pageAlbums = albums.slice(0, limit);

        imageBuffer = await createMusicPageImage(pageAlbums, page, limit);
        await saveMusicPageImage(cacheKey, imageBuffer);
    } else {
        const checkNext = await getMusicPageAlbums(params, page, limit + 1);
        hasNext = checkNext.length > limit;
    }

    const formData = new FormData();
    formData.append('file', new Blob([imageBuffer]), 'music-page.png');

    const components = [
        {
            type: ComponentType.ActionRow,
            components: [
                {
                    type: ComponentType.Button,
                    style: 1,
                    custom_id: `mpage:${sessionId}:${page - 1}`,
                    label: '◀ Previous',
                    disabled: page <= 1
                },
                {
                    type: ComponentType.Button,
                    style: 1,
                    custom_id: `mpage:${sessionId}:${page + 1}`,
                    label: 'Next ▶',
                    disabled: !hasNext
                }
            ]
        }
    ];

    formData.append('payload_json', JSON.stringify({
        content: `### 🎵 Music Page - Page ${page}`,
        components
    }));

    await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
        method: 'PATCH',
        body: formData,
    });
}

export async function handleMusicPage(interaction: APIChatInputApplicationCommandInteraction, waitUntil: (promise: Promise<any>) => void) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const processCommand = async () => {
        try {
            const actingUserId = interaction.member?.user.id || interaction.user?.id;
            if (!actingUserId) return;

            const options = interaction.data.options || [];
            
            const rawGenres = (options.find(o => o.name === 'genres') as APIApplicationCommandInteractionDataStringOption)?.value;
            const rawArtists = (options.find(o => o.name === 'artists') as APIApplicationCommandInteractionDataStringOption)?.value;
            const rawTitles = (options.find(o => o.name === 'titles') as APIApplicationCommandInteractionDataStringOption)?.value;
            const userId = (options.find(o => o.name === 'user') as APIApplicationCommandInteractionDataUserOption)?.value;
            const rawMinRating = (options.find(o => o.name === 'rating_filter') as any)?.value;
            const minRating = rawMinRating !== undefined ? Number(rawMinRating) : undefined;
            const sort = ((options.find(o => o.name === 'sort') as APIApplicationCommandInteractionDataStringOption)?.value || 'highest') as 'highest' | 'popular' | 'unrated' | 'recent';
            const page = 1;

            const genres = rawGenres ? rawGenres.split(',').map(g => mapLastFmTagToGenre(g.trim())).filter(Boolean) as string[] : [];
            const artists = rawArtists ? rawArtists.split(',').map(a => a.trim()).filter(Boolean) : [];
            const titles = rawTitles ? rawTitles.split(',').map(t => t.trim()).filter(Boolean) : [];

            const params: MusicPageOptions = {
                genres, artists, titles, userId, minRating, sort, actingUserId
            };

            const sessionId = await saveMusicPageSession(params);
            await sendMusicPageResponse(interaction.application_id, interaction.token, sessionId, page, params);
        } catch(e) {
            console.error("[MUSIC PAGE] Error generating:", e);
            await updateResponse(interaction.application_id, interaction.token, { content: "An error occurred while generating the music page." });
        }
    };

    waitUntil(processCommand());
    return new NextResponse(null, { status: 204 });
}

export async function handleMusicPageButton(interaction: APIMessageComponentButtonInteraction, waitUntil: (promise: Promise<any>) => void) {
    const customId = interaction.data.custom_id;
    const [, sessionId, pageStr] = customId.split(':');
    const page = parseInt(pageStr, 10);

    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredMessageUpdate }),
        headers: { 'Content-Type': 'application/json' },
    });

    const processButton = async () => {
        try {
            const params = await getMusicPageSession(sessionId);
            if (!params) {
                await updateResponse(interaction.application_id, interaction.token, { content: "This music page session has expired." });
                return;
            }
            await sendMusicPageResponse(interaction.application_id, interaction.token, sessionId, page, params);
        } catch(e) {
            console.error("[MUSIC PAGE] Button error:", e);
        }
    };

    waitUntil(processButton());
    return new NextResponse(null, { status: 204 });
}