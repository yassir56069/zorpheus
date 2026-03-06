import { NextResponse } from 'next/server';
// Import your Turso db instance here
import { db } from '@/utils/db'; 

export const maxDuration = 60; 
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    // Start a timer to prevent hitting Vercel's 60s hard timeout
    const startTime = Date.now();
    const MAX_EXECUTION_TIME_MS = 50000; // 50 seconds (leaves 10s for the DB batch write)

    // 1. Secure the endpoint using Vercel's Cron Secret
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Query the top 200 albums that STILL need a cover
    const sql = `
        WITH UserStats AS (
            SELECT COUNT(DISTINCT userId) as totalUsers FROM ratings
        ),
        CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
        ),
        CombinedRatings AS (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT albumId, SUM(score) as sumScore, COUNT(userId) as ratingCount
            FROM CombinedRatings
            GROUP BY albumId
        )
        SELECT a.name, a.artistName, a.slug,
            (CAST(s.sumScore AS FLOAT) / NULLIF((SELECT totalUsers FROM UserStats), 0)) / 2.0 as weightedScore
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        WHERE a.COVERARTURL IS NULL 
        ORDER BY weightedScore DESC
        LIMIT 200
    `;

    const result = await db.execute(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const albums = result.rows as any[];

    if (albums.length === 0) {
        return NextResponse.json({ message: 'No albums need covers!' });
    }

    const updates: { sql: string; args: string[] }[] =[];

    // 3. Loop sequentially to respect rate limits
    for (const album of albums) {
        // SAFETY VALVE: Check if we are approaching the 60s Vercel limit
        if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
            console.log('Approaching 60s timeout limit. Stopping fetch loop early.');
            break; 
        }

        try {
            const artist = encodeURIComponent(album.artistName as string);
            const albumName = encodeURIComponent(album.name as string);
            const apiKey = process.env.LASTFM_API_KEY;
            
            const response = await fetch(
                `http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${apiKey}&artist=${artist}&album=${albumName}&format=json`
            );

            if (!response.ok) throw new Error(`API returned ${response.status}`);

            const data = await response.json();
            const images = data.album?.image;
            
            let finalCoverUrl = ''; 

            if (images && Array.isArray(images)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const xlImage = images.find((img: any) => img.size === 'extralarge') || images[images.length - 1];
                if (xlImage && xlImage['#text']) {
                    finalCoverUrl = xlImage['#text'];
                }
            }

            // Queue up the Turso query for execution later
            updates.push({
                sql: 'UPDATE albums SET COVERARTURL = ? WHERE slug = ?',
                args:[finalCoverUrl, album.slug as string]
            });

            // Brief 100ms delay to ensure we easily stay under the 5 req/sec limit
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            console.error(`Failed to fetch cover for ${album.slug}:`, error);
            // Break loop early on API failures so we save the ones we already got
            break; 
        }
    }

    // 4. Batch push updates to Turso
    if (updates.length > 0) {
        await db.batch(updates);
    }

    return NextResponse.json({ 
        message: `Processed ${updates.length} albums in ${((Date.now() - startTime) / 1000).toFixed(2)} seconds.` 
    });
}