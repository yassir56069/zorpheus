import { db } from '@/utils/db';



/**
 * Gets or creates an album in the database.
 */
export async function getOrCreateAlbum(albumData: {
    name: string;
    artistName: string;
    mbid?: string | null;
    releaseYear?: string | null;
    userId: string;
}) {
    const slug = generateSlug(albumData.artistName, albumData.name);
    
    try {
        const result = await db.execute({
            sql: `
                INSERT INTO albums (mbid, name, artistName, slug, releaseYear, fromUser, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(slug) DO UPDATE SET 
                    name = name,
                    releaseYear = COALESCE(albums.releaseYear, excluded.releaseYear)
                RETURNING *
            `,
            args: [
                albumData.mbid || null, 
                albumData.name, 
                albumData.artistName, 
                slug, 
                albumData.releaseYear || null,
                albumData.userId
            ]
        });
        return result.rows[0];
    } catch (e) {
        console.error("Error in getOrCreateAlbum:", e);
        return null;
    }
}

/**
 * Upserts a rating
 * score: 1 to 10 (representing 0.5 to 5.0)
 */
export async function upsertRating(userId: string, albumId: string, score: number) {
    return await db.execute({
        sql: `
            INSERT INTO ratings (userId, albumId, score, createdAt, updatedAt)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(userId, albumId) DO UPDATE SET
                score = excluded.score,
                updatedAt = CURRENT_TIMESTAMP
        `,
        args: [userId, albumId, score]
    });
}

/**
 * Batches a large list of album creations and ratings into SQLite transactions
 * Chunked by 100 to prevent Vercel/Turso payload limits.
 */
export async function batchImportRatings(userId: string, records: Array<{
    artistName: string, 
    albumName: string, 
    releaseYear: string, 
    score: number
}>) {
    const BATCH_SIZE = 100;
    
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const chunk = records.slice(i, i + BATCH_SIZE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const statements: any[] = [];
        
        for (const record of chunk) {
            const slug = generateSlug(record.artistName, record.albumName);
            
            // 1. Album Upsert Statement
            statements.push({
                sql: `
                    INSERT INTO albums (name, artistName, slug, releaseYear, fromUser, createdAt)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(slug) DO UPDATE SET 
                        releaseYear = COALESCE(albums.releaseYear, excluded.releaseYear)
                `,
                args: [record.albumName, record.artistName, slug, record.releaseYear || null, userId]
            });
            
            // 2. Rating Upsert Statement
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
        
        // Execute chunk simultaneously
        await db.batch(statements, "write");
    }
}

//#region Profile Display

/**
 * Gets the distribution of scores (1-10) for a specific user.
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
    return result.rows as unknown as Array<{ score: number, count: number }>;
}

/**
 * Gets the most recent ratings for a specific user.
 */
export async function getUserRecentRatings(userId: string, limit: number = 10) {
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
    return result.rows as unknown as Array<{ albumName: string, artistName: string, score: number, updatedAt: string }>;
}

//#endregion

//#region Helper Methods

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

export function generateSlug(artistName: string, albumName: string): string {
    const artistPart = normalizeString(artistName);
    const albumPart = normalizeString(getBaseName(albumName));
    return `${artistPart}-${albumPart}`;
}

//#endregion