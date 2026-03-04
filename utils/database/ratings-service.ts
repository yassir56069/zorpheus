import { db } from '@/utils/db';


/**
 * Gets or creates an album in the database.
 */
export async function getOrCreateAlbum(albumData: {
    name: string;
    artistName: string;
    mbid?: string | null;
    userId: string;
}) {
    const slug = generateSlug(albumData.artistName, albumData.name);
    
    // Attempt to insert. If slug exists, it returns the existing record.
    // SQLite with LibSQL supports RETURNING *
    try {
        const result = await db.execute({
            sql: `
                INSERT INTO albums (mbid, name, artistName, slug, fromUser, createdAt)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(slug) DO UPDATE SET name = name
                RETURNING *
            `,
            args: [albumData.mbid || null, albumData.name, albumData.artistName, slug, albumData.userId]
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

//#region  Helper Methods

// --- Normalization Logic provided by you ---
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
