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

    // UPDATED SQL: 
    // 1. Mirrors getTopAlbums ranking completely
    // 2. Filters out score = 0
    // 3. Demands ratingCount >= 3 to cover bases for top-chart (5) and genre-chart (3)
    // 4. Filters for missing covers/genres
    const sql = `
        WITH CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug 
            FROM albums a 
            LEFT JOIN albums c ON a.canonicalId = c.id
        ),
        CombinedRatings AS (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score 
            FROM ratings r 
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug 
            WHERE r.score > 0 
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT 
                albumId, 
                SUM(score) as sumScore, 
                COUNT(userId) as ratingCount,
                (CAST(SUM(score) AS FLOAT) / COUNT(userId)) as avgScore
            FROM CombinedRatings 
            GROUP BY albumId
        )
        SELECT 
            a.name, 
            a.artistName, 
            a.slug, 
            a.COVERARTURL, 
            a.genresChecked
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        WHERE s.ratingCount >= 3 
          AND (
            a.COVERARTURL IS NULL 
            OR a.genresChecked IS NULL 
            OR a.genresChecked = FALSE 
            OR a.genresChecked = 0
          )
        ORDER BY s.avgScore DESC, s.ratingCount DESC
        LIMIT 200
    `;

    const result = await db.execute(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const albums = result.rows as any[];

    if (albums.length === 0) return NextResponse.json({ message: 'No albums need processing!' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: { sql: string; args: any[] }[] =[];
    
    // Track stats for the final report
    let coverFoundCount = 0;
    let coverNotFoundCount = 0;
    let genresLinkedCount = 0; 
    let albumsProcessedCount = 0;

    for (const album of albums) {
        if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
            console.log('⏳ Reached time limit. Saving progress...');
            break; 
        }

        try {
            // Determine independently what this album is missing
            const needsCover = !album.COVERARTURL; // Null or empty string
            const needsGenreCheck = !album.genresChecked; // Null, false, or 0

            const artist = encodeURIComponent(album.artistName as string);
            const albumName = encodeURIComponent(album.name as string);
            
            // Only one fetch needed since Last.fm returns both image & tags
            const response = await fetch(
                `http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${process.env.LASTFM_API_KEY}&artist=${artist}&album=${albumName}&format=json`
            );

            const data = await response.json();
            
            const updateClauses: string[] = [];
            const updateArgs: unknown[] =[];

            // --- 1. PROCESS COVER ART ---
            if (needsCover) {
                const images = data.album?.image;
                let finalCoverUrl = ''; 

                if (images && Array.isArray(images)) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const xlImage = images.find((img: any) => img.size === 'extralarge') || images[images.length - 1];
                    if (xlImage && xlImage['#text']) {
                        finalCoverUrl = xlImage['#text'];
                    }
                }

                if (finalCoverUrl) {
                    coverFoundCount++;
                    console.log(`✅ [COVER FOUND] ${album.artistName} - ${album.name}`);
                } else {
                    coverNotFoundCount++;
                    console.log(`❌ [COVER NOT FOUND] ${album.artistName} - ${album.name}`);
                }

                updateClauses.push('COVERARTURL = ?');
                // Even if not found, we save '' so it is no longer NULL, preventing infinite retry loops
                updateArgs.push(finalCoverUrl); 
            }

            // --- 2. PROCESS GENRES ---
            if (needsGenreCheck) {
                let lastfmTags: string[] =[];
                if (data?.album?.tags?.tag) {
                    const tags = data.album.tags.tag;
                    if (Array.isArray(tags)) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        lastfmTags = tags.map((t: any) => t.name);
                    } else if (typeof tags === 'object' && tags !== null) {
                        lastfmTags = [tags.name]; 
                    }
                }

                if (lastfmTags.length > 0) {
                    await linkAlbumGenres(album.slug as string, lastfmTags, 'cron');
                    genresLinkedCount++;
                    console.log(`🎵 [GENRES LINKED] ${album.artistName} - ${album.name}`);
                }

                // Regardless of whether genres were found or not, we flag it as checked so we don't spam Last.fm
                updateClauses.push('genresChecked = ?');
                updateArgs.push(1); // 1 acts as true for most SQL implementations
            }

            // Push our dynamically built batch query for this specific album
            if (updateClauses.length > 0) {
                updates.push({
                    sql: `UPDATE albums SET ${updateClauses.join(', ')} WHERE slug = ?`,
                    args: [...updateArgs, album.slug as string]
                });
            }

            albumsProcessedCount++;

            // Small delay to respect Last.fm API limits
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`🚨 Error fetching ${album.slug}:`, error);
            break; 
        }
    }

    if (updates.length > 0) {
        await db.batch(updates); // Push cover art and genre flag updates
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = `Processed ${albumsProcessedCount} albums. Found ${coverFoundCount} covers. Linked genres for ${genresLinkedCount} albums in ${duration}s.`;
    
    console.log(`📊 CRON SUMMARY: ${summary}`);
    
    return NextResponse.json({ message: summary });
}