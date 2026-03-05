import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    APIApplicationCommandInteractionDataBooleanOption
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';
import sharp from 'sharp';
import path from 'path';
import { createCanvas, registerFont } from 'canvas';
import { getUserLastFM } from '@/utils/database/user-service';

// --- FONT REGISTRATION ---
// We now register two fonts: Courier New for primary text, and a CJK font for fallbacks.
try {
    const primaryFontPath = path.join(process.cwd(), 'public', 'fonts', 'cour.ttf');
    registerFont(primaryFontPath, { family: 'Courier New' });
    console.log("Primary font 'cour.ttf' (Courier New) registered successfully.");

    // --- NEW: Register the CJK fallback font ---
    const fallbackFontPath = path.join(process.cwd(), 'public', 'fonts', 'NotoSansJP-Bold.ttf');
    registerFont(fallbackFontPath, { family: 'Noto Sans JP' });
    console.log("Fallback font 'NotoSansJP-Bold.ttf' registered successfully.");

} catch (error) {
    console.error("CRITICAL: Could not register fonts. Make sure 'cour.ttf' and 'NotoSansJP-Bold.ttf' exist in public/fonts/.", error);
}

// Define a type for the album data
type Album = {
    name: string;
    artist: {
        name: string;
    };
    image: { '#text': string, size: string }[];
    playcount: number; // playcount from API is a string
};


// Define a new type for our aggregated data
type AggregatedAlbum = {
    name: string;
    artist: {
        name: string;
    };
    image: { '#text': string, size: string }[];
    playcount: number; // We will store playcount as a number
};

// --- HELPER FUNCTIONS FOR FILTERING ---

function isGreyImage(album: Album | AggregatedAlbum): boolean {
    const imageUrl = album.image.find((img) => img.size === 'extralarge')?.['#text'] || 
                     album.image.find((img) => img.size === 'large')?.['#text'] || '';
    
    return !imageUrl || 
           imageUrl.trim() === '' || 
           imageUrl.includes('/2a96cbd8b46e442fc41c2b86b821562f.png');
}

function normalizeString(str: string): string {
    const normalized = str.toLowerCase().replace(/[\s\p{P}]/gu, '');
    return normalized === '' ? str.toLowerCase().replace(/\s/g, '') : normalized;
}

function getBaseName(albumName: string): string {
    const base = albumName
        .replace(/\s*[\(\[].*?remaster.*?[\)\]]/gi, '')
        .replace(/\s*-.*?remaster.*/gi, '')
        .replace(/\s*[\(\[].*?[\)\]]/g, '')
        .replace(/\s*-.*$/, '')
        .trim();

    return base === '' ? albumName : base;
}

function isBetterVersion(current: Album | AggregatedAlbum, incoming: Album | AggregatedAlbum): boolean {
    const currentIsRemaster = current.name.toLowerCase().includes('remaster');
    const incomingIsRemaster = incoming.name.toLowerCase().includes('remaster');
    if (currentIsRemaster && !incomingIsRemaster) return true;
    if (!currentIsRemaster && !incomingIsRemaster) {
        return incoming.name.length < current.name.length;
    }
    return false;
}

// #region server chart

export async function handleServerChart(interaction: APIChatInputApplicationCommandInteraction) {
    await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: 'POST',
        body: JSON.stringify({ type: InteractionResponseType.DeferredChannelMessageWithSource }),
        headers: { 'Content-Type': 'application/json' },
    });

    const options = (interaction.data.options || []);
    const sizeOption = (options.find(opt => opt.name === 'size') as APIApplicationCommandInteractionDataStringOption)?.value || '3x3';
    const [gridWidth, gridHeight] = sizeOption.split('x').map(Number);
    const limit = gridWidth * gridHeight;
    const displayStyle = (options.find(opt => opt.name === 'labelling') as APIApplicationCommandInteractionDataStringOption)?.value || 'no_names';
    const period = (options.find(opt => opt.name === 'period') as APIApplicationCommandInteractionDataStringOption)?.value || '7day';
    
    // Parameters
    const filterRemastered = (options.find(opt => opt.name === 'filter_remastered') as APIApplicationCommandInteractionDataBooleanOption)?.value ?? true;
    const filterGreys = (options.find(opt => opt.name === 'filter_greys') as APIApplicationCommandInteractionDataBooleanOption)?.value ?? true;

    const apiKey = process.env.LASTFM_API_KEY;

    try {
        const userKeys: string[] = [];
        for await (const key of kv.scanIterator()) {
            userKeys.push(key);
        }

        if (userKeys.length === 0) {
            const content = 'No users have registered their Last.fm accounts yet.';
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const lastfmUsernames = (await kv.mget(...userKeys)) as string[];

        const fetchPromises = lastfmUsernames.map(username => {
            if (!username) return null;
            const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&period=${period}&api_key=${apiKey}&format=json&limit=200`;
            return fetch(apiUrl).then(res => res.json());
        }).filter(Boolean);

        const results = await Promise.allSettled(fetchPromises);
        const albumScrobbles = new Map<string, AggregatedAlbum>();

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.topalbums) {
                const albums: Album[] = result.value.topalbums.album;
                for (const album of albums) {
                    
                    // Filter Greys
                    if (filterGreys && isGreyImage(album)) continue;

                    // Grouping Logic
                    const artistPart = normalizeString(album.artist.name);
                    const albumBaseName = filterRemastered ? getBaseName(album.name) : album.name;
                    const albumPart = normalizeString(albumBaseName);
                    const key = `${artistPart}-${albumPart}`;
                    
                    const playCount = parseInt(album.playcount.toString(), 10);

                    if (albumScrobbles.has(key)) {
                        const existing = albumScrobbles.get(key)!;
                        existing.playcount += playCount;
                        if (isBetterVersion(existing, album)) {
                            existing.name = album.name;
                            existing.image = album.image;
                        }
                    } else {
                        albumScrobbles.set(key, { ...album, playcount: playCount });
                    }
                }
            }
        }

        const sortedAlbums = Array.from(albumScrobbles.values())
            .sort((a, b) => b.playcount - a.playcount)
            .slice(0, limit);

        if (sortedAlbums.length < limit) {
             const content = `Not enough unique albums found for a ${sizeOption} chart. Found ${sortedAlbums.length}.`;
             await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const chartImageBuffer = await createChartImage(sortedAlbums, gridWidth, gridHeight, displayStyle);
        const formData = new FormData();
        formData.append('file', new Blob([chartImageBuffer]), 'server-chart.png');
        
        const periodDisplayNames: { [key: string]: string } = {
            '7day': 'Last 7 Days', '1month': 'Last Month', '3month': 'Last 3 Months',
            '6month': 'Last 6 Months', '12month': 'Last Year', 'overall': 'All Time'
        };
        const content = `-# *OrpheusCore Top Albums (${periodDisplayNames[period]})*`;
        formData.append('payload_json', JSON.stringify({ content }));

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', body: formData,
        });

    } catch (error) {
        console.error("Server Chart error:", error);
    }
    return new NextResponse(null, { status: 204 });
}
// #endregion


/**
 * --- MODIFIED FUNCTION ---
 * The font property now includes a comma-separated fallback font family.
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

    // --- CHANGE: Added "Noto Sans JP" as the second font in the list. ---
    // The renderer will try Courier New first, and if a character is missing, it will use Noto Sans JP.
    ctx.font = `bold ${fontSize}px "Courier New", "Noto Sans JP"`;
    ctx.fillStyle = 'white';
    ctx.textAlign = anchor;
    ctx.textBaseline = 'top';
    
    let startY = 15;
    const x = anchor === 'center' ? width / 2 : 10;
    
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
 * This function remains unchanged from the previous version.
 */
async function createChartImage(albums: Album[], gridWidth: number, gridHeight: number, displayStyle: string): Promise<Buffer> {
    const imageSize = gridWidth > 8 || gridHeight > 8 ? 150 : 300;
    const underTextHeight = displayStyle === 'under' ? 40 : 0;
    const topsterTextWidth = displayStyle === 'topster' ? 450 : 0;

    let fontSize, lineHeight, charLimit;
    if (imageSize === 150) {
        fontSize = 11;
        lineHeight = 15;
        charLimit = 60;
        console.log(`Dense chart detected (${gridWidth}x${gridHeight}). Using smaller font size.`);
    } else {
        fontSize = 14;
        lineHeight = 22;
        charLimit = 48;
    }

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
                return fullName.length > charLimit ? fullName.substring(0, charLimit - 3) + '...' : fullName;
            });

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

    const options = (interaction.data.options || []);
    let lastfmUsername = (options.find(opt => opt.name === 'user') as APIApplicationCommandInteractionDataStringOption)?.value || null;
    const sizeOption = (options.find(opt => opt.name === 'size') as APIApplicationCommandInteractionDataStringOption)?.value || '3x3';
    const [gridWidth, gridHeight] = sizeOption.split('x').map(Number);
    const limit = gridWidth * gridHeight;
    const displayStyle = (options.find(opt => opt.name === 'labelling') as APIApplicationCommandInteractionDataStringOption)?.value || 'no_names';
    const period = (options.find(opt => opt.name === 'period') as APIApplicationCommandInteractionDataStringOption)?.value || '7day';

    // Parameters
    const filterRemastered = (options.find(opt => opt.name === 'filter_remastered') as APIApplicationCommandInteractionDataBooleanOption)?.value ?? true;
    const filterGreys = (options.find(opt => opt.name === 'filter_greys') as APIApplicationCommandInteractionDataBooleanOption)?.value ?? true;

    if (!lastfmUsername) {
        const discordUserId = interaction.member!.user.id;
        lastfmUsername = await getUserLastFM(discordUserId); 
        if (!lastfmUsername) {
            const content = 'Please register your Last.fm username with `/register`.';
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }
    }

    const apiKey = process.env.LASTFM_API_KEY;
    const fetchLimit = Math.max(limit * 3, 150); 
    const apiUrl = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${lastfmUsername}&period=${period}&api_key=${apiKey}&format=json&limit=${fetchLimit}`;

    try {
        const response = await fetch(apiUrl);
        const data = await response.json();
        if (data.error || !data.topalbums) throw new Error("Last.fm API error");

        const rawAlbums: Album[] = data.topalbums.album;
        const filteredMap = new Map<string, Album>();

        for (const album of rawAlbums) {
            // 1. Filter Greys
            if (filterGreys && isGreyImage(album)) continue;

            // 2. Filter Remastered/Deluxe
            const artistPart = normalizeString(album.artist.name);
            const albumBaseName = filterRemastered ? getBaseName(album.name) : album.name;
            const albumPart = normalizeString(albumBaseName);
            const key = `${artistPart}-${albumPart}`;

            if (filteredMap.has(key)) {
                const existing = filteredMap.get(key)!;
                if (isBetterVersion(existing, album)) {
                    filteredMap.set(key, album);
                }
            } else {
                filteredMap.set(key, album);
            }
        }

        const finalAlbums = Array.from(filteredMap.values()).slice(0, limit);

        if (finalAlbums.length < limit) {
            const content = `Could not find enough albums for \`${lastfmUsername}\` after filtering. Found ${finalAlbums.length}.`;
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
                method: 'PATCH', body: JSON.stringify({ content }), headers: { 'Content-Type': 'application/json' },
            });
            return new NextResponse(null, { status: 204 });
        }

        const chartImageBuffer = await createChartImage(finalAlbums, gridWidth, gridHeight, displayStyle);
        const formData = new FormData();
        formData.append('file', new Blob([chartImageBuffer]), 'chart.png');
        
        const periodDisplayNames: { [key: string]: string } = {
            '7day': 'Last 7 Days', '1month': 'Last Month', '3month': 'Last 3 Months',
            '6month': 'Last 6 Months', '12month': 'Last Year', 'overall': 'All Time'
        };
        const content = `-# *Top Albums (${periodDisplayNames[period]}) - **${lastfmUsername}***`;
        formData.append('payload_json', JSON.stringify({ content }));

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', body: formData,
        });

    } catch (error) {
        console.error("Chart error:", error);
    }
    return new NextResponse(null, { status: 204 });
}