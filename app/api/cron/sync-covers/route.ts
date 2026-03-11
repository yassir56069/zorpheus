import { NextResponse } from 'next/server';
import { db } from '@/utils/db'; 
// 👇 Import the genre linking function (adjust the path if needed)
import { linkAlbumGenres } from '@/utils/database/genre-service';

export const maxDuration = 60; 
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const startTime = Date.now();
    const MAX_EXECUTION_TIME_MS = 50000;

    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // NOTE: This currently only selects albums not missing covers.
    // Genres will be populated automatically for any newly processed missing-cover albums!
    const sql = `
        WITH UserStats AS (SELECT COUNT(DISTINCT userId) as totalUsers FROM ratings),
        CanonicalAlbums AS (SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug FROM albums a LEFT JOIN albums c ON a.canonicalId = c.id),
        CombinedRatings AS (SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score FROM ratings r JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug GROUP BY ca.canonical_slug, r.userId),
        AlbumSums AS (SELECT albumId, SUM(score) as sumScore, COUNT(userId) as ratingCount FROM CombinedRatings GROUP BY albumId)
        SELECT a.name, a.artistName, a.slug
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        WHERE a.COVERARTURL IS NOT NULL 
        ORDER BY (CAST(s.sumScore AS FLOAT) / NULLIF((SELECT totalUsers FROM UserStats), 0)) / 2.0 DESC
        LIMIT 200
    `;

    const result = await db.execute(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const albums = result.rows as any[];

    if (albums.length === 0) return NextResponse.json({ message: 'No albums need covers!' });

    const updates: { sql: string; args: string[] }[] =[];
    
    // Track stats for the final report
    let foundCount = 0;
    let notFoundCount = 0;
    let genresLinkedCount = 0; // NEW: Track successfully linked genres

    for (const album of albums) {
        if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
            console.log('⏳ Reached time limit. Saving progress...');
            break; 
        }

        try {
            const artist = encodeURIComponent(album.artistName as string);
            const albumName = encodeURIComponent(album.name as string);
            
            const response = await fetch(
                `http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${process.env.LASTFM_API_KEY}&artist=${artist}&album=${albumName}&format=json`
            );

            const data = await response.json();
            const images = data.album?.image;
            let finalCoverUrl = ''; 

            // --- 1. PROCESS COVER ART ---
            if (images && Array.isArray(images)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const xlImage = images.find((img: any) => img.size === 'extralarge') || images[images.length - 1];
                if (xlImage && xlImage['#text']) {
                    finalCoverUrl = xlImage['#text'];
                }
            }

            if (finalCoverUrl) {
                foundCount++;
                console.log(`✅ [FOUND] ${album.artistName} - ${album.name}`);
            } else {
                notFoundCount++;
                console.log(`❌ [NOT FOUND] ${album.artistName} - ${album.name}`);
            }

            updates.push({
                sql: 'UPDATE albums SET COVERARTURL = ? WHERE slug = ?',
                args: [finalCoverUrl, album.slug as string]
            });

            // --- 2. PROCESS GENRES ---
            let lastfmTags: string[] =[];
            if (data?.album?.tags?.tag) {
                const tags = data.album.tags.tag;
                if (Array.isArray(tags)) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    lastfmTags = tags.map((t: any) => t.name);
                } else if (typeof tags === 'object' && tags !== null) {
                    lastfmTags = [tags.name]; // Handling Last.fm 1-item object quirk
                }
            }

            if (lastfmTags.length > 0) {
                // Await to ensure the genres are safely linked into DB sequentially
                // Passing 'cron' as the generic userId doing the inserting
                await linkAlbumGenres(album.slug as string, lastfmTags, 'cron');
                genresLinkedCount++;
            }

            // Small delay to respect Last.fm API limits
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`🚨 Error fetching ${album.slug}:`, error);
            break; 
        }
    }

    if (updates.length > 0) {
        await db.batch(updates); // Push cover art updates
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = `Processed ${updates.length} albums (${foundCount} found covers). Linked genres for ${genresLinkedCount} albums in ${duration}s.`;
    
    console.log(`📊 CRON SUMMARY: ${summary}`);
    
    return NextResponse.json({ message: summary });
}