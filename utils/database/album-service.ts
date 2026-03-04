import { db } from '@/utils/db';

export interface AlbumStats {
    name: string;
    artistName: string;
    slug: string;
    mbid: string | null;
    releaseYear: string | null;
    coverArtUrl: string | null;
    avgScore: number | null;
    ratingCount: number | null;
    rank: number | null;
}

export interface UserRating {
    userId: string;
    score: number;
    updatedAt: string;
}

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
 * Gets an album by its slug, dynamically calculating its average score, 
 * rating count, and overall ranking among all albums.
 */
export async function getAlbumWithStats(slug: string): Promise<AlbumStats | null> {
    const sql = `
        WITH AlbumStats AS (
            SELECT albumId, AVG(score) as avgScore, COUNT(userId) as ratingCount
            FROM ratings 
            GROUP BY albumId
        ),
        RankedAlbums AS (
            SELECT 
                albumId, 
                avgScore, 
                ratingCount, 
                RANK() OVER(ORDER BY avgScore DESC, ratingCount DESC) as rank
            FROM AlbumStats
        )
        SELECT 
            a.name, a.artistName, a.slug, a.mbid, a.releaseYear, a.coverArtUrl,
            r.avgScore, r.ratingCount, r.rank
        FROM albums a
        LEFT JOIN RankedAlbums r ON a.slug = r.albumId
        WHERE a.slug = ?
    `;

    const result = await db.execute({ sql, args: [slug] });
    if (result.rows.length === 0) return null;
    
    return result.rows[0] as unknown as AlbumStats;
}

/**
 * Searches albums by name, artist, or slug
 */
export async function searchAlbums(query: string) {
    const searchTerm = `%${query}%`;
    const sql = `
        SELECT name, artistName, slug, releaseYear
        FROM albums
        WHERE name LIKE ? OR artistName LIKE ? OR slug LIKE ?
        LIMIT 25
    `;
    const result = await db.execute({ sql, args: [searchTerm, searchTerm, searchTerm] });
    return result.rows as unknown as Array<{ name: string, artistName: string, slug: string, releaseYear: string | null }>;
}

/**
 * Updates the cover art URL for an album
 */
export async function updateAlbumCoverArt(slug: string, url: string) {
    await db.execute({
        sql: `UPDATE albums SET coverArtUrl = ? WHERE slug = ?`,
        args: [url, slug]
    });
}

/**
 * Gets all user ratings for a specific album
 */
export async function getAlbumRatings(slug: string): Promise<UserRating[]> {
    const sql = `
        SELECT userId, score, updatedAt
        FROM ratings
        WHERE albumId = ?
        ORDER BY score DESC
    `;
    const result = await db.execute({ sql, args: [slug] });
    return result.rows as unknown as UserRating[];
}

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