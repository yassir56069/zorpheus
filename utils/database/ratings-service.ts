import { db } from '@/utils/db';
import { generateSlug, updateSingleAlbumCache, invalidateAlbumRankingsCache } from './album-service';
import { recordFeaturedRating } from './feature-service';

/**
 * Upserts a rating.
 * score: 1 to 10 (representing 0.5 to 5.0)
 * Automatically awards feature points if the album is currently featured.
 */
export async function upsertRating(userId: string, albumId: string, score: number) {
    const result = await db.execute({
        sql: `
            INSERT INTO ratings (userId, albumId, score, createdAt, updatedAt)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(userId, albumId) DO UPDATE SET
                score = excluded.score,
                updatedAt = CURRENT_TIMESTAMP
        `,
        args: [userId, albumId, score]
    });

    // Update the cache instantly so the frontend UI re-renders with the exact new stats/ranking!
    await updateSingleAlbumCache(albumId).catch(e => 
        console.error('[RATINGS] Target cache update failed:', e)
    );

    // Fire-and-forget: award feature points if this album is currently featured.
    recordFeaturedRating(userId, albumId, score).catch(e =>
        console.error('[RATINGS] Feature point award failed:', e)
    );

    return result;
}

/**
 * Batches a large list of album creations and ratings into SQLite transactions.
 * Chunked by 100 to prevent Vercel/Turso payload limits.
 * Note: batch imports do NOT award feature points.
 */
export async function batchImportRatings(userId: string, records: Array<{
    artistName: string;
    albumName: string;
    releaseYear: string | null;
    score: number;
}>) {
    const BATCH_SIZE = 100;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const chunk = records.slice(i, i + BATCH_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const statements: any[] = [];

        for (const record of chunk) {
            const slug = generateSlug(record.artistName, record.albumName, record.releaseYear);

            statements.push({
                sql: `
                    INSERT INTO albums (name, artistName, slug, releaseYear, fromUser, createdAt)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(slug) DO UPDATE SET
                        releaseYear = COALESCE(albums.releaseYear, excluded.releaseYear)
                `,
                args: [record.albumName, record.artistName, slug, record.releaseYear, userId]
            });

            statements.push({
                sql: `
                    INSERT INTO ratings (userId, albumId, score, createdAt, updatedAt)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT(userId, albumId) DO UPDATE SET
                        score = excluded.score,
                        updatedAt = CURRENT_TIMESTAMP
                `,
                args: [userId, slug, record.score]
            });
        }

        await db.batch(statements, "write");
    }

    // Since many albums were imported, just invalidate the cache completely. 
    // This allows it to rebuild gracefully the next time an album command is called.
    await invalidateAlbumRankingsCache();
}

//#region Profile Display

/**
 * Gets the distribution of scores (0-10) for a specific user.
 */
export async function getUserRatingDistribution(userId: string) {
    const result = await db.execute({
        sql: `
            SELECT score, COUNT(*) as count
            FROM ratings
            WHERE userId = ?
            GROUP BY score
            ORDER BY score DESC
        `,
        args: [userId]
    });
    return result.rows as unknown as Array<{ score: number; count: number }>;
}

/**
 * Gets the most recent ratings for a specific user.
 */
export async function getUserRecentRatings(userId: string, limit: number = 9) {
    const result = await db.execute({
        sql: `
            SELECT a.name as albumName, a.artistName, r.score, r.updatedAt
            FROM ratings r
            JOIN albums a ON r.albumId = a.slug
            WHERE r.userId = ?
            ORDER BY r.updatedAt DESC
            LIMIT ?
        `,
        args: [userId, limit]
    });
    return result.rows as unknown as Array<{
        albumName: string;
        artistName: string;
        score: number;
        updatedAt: string;
    }>;
}

//#endregion