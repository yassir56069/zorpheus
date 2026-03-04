import { db } from '@/utils/db';
import { generateSlug } from './album-service';



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
