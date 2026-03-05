import { db } from '@/utils/db';

export interface TopAlbumResult extends AlbumStats {
    totalScore: number;
}

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
 * Retrieves the top rated albums with pagination and optional date filtering.
 */
export async function getTopAlbums(options: {
    page?: number;
    limit?: number;
    days?: number;
}) {
    const { page = 1, limit = 20, days } = options;
    const offset = (page - 1) * limit;

    // Filter for date range if provided
    const dateFilter = days 
        ? `WHERE createdAt >= datetime('now', '-${days} days')` 
        : '';

    const sql = `
        WITH UserStats AS (
            SELECT COUNT(DISTINCT userId) as totalUsers FROM ratings
        ),
        AlbumSums AS (
            SELECT 
                albumId, 
                SUM(score) as sumScore, 
                COUNT(userId) as ratingCount
            FROM ratings
            ${dateFilter}
            GROUP BY albumId
        )
        SELECT 
            a.name, 
            a.artistName, 
            a.slug,
            s.ratingCount,
            -- Weighted Score: (Sum of all ratings / Total users in bot) / 2 (to get 0-5 scale)
            (CAST(s.sumScore AS FLOAT) / (SELECT totalUsers FROM UserStats)) / 2.0 as weightedScore
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        ORDER BY weightedScore DESC
        LIMIT ? OFFSET ?
    `;

    const result = await db.execute({ sql, args: [limit, offset] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows as any[];
}

/**
 * Gets or creates an album in the database.
 */
// album-service.ts

export async function getOrCreateAlbum(albumData: {
    name: string;
    artistName: string;
    mbid?: string | null;
    releaseYear?: string | null;
    userId: string;
}) {
    // 1. Generate the slug using the year if available
    const slug = generateSlug(albumData.artistName, albumData.name, albumData.releaseYear);
    
    try {
        // 2. Perform a "Smart Upsert"
        // We use the slug as the unique identifier. 
        // If the slug already exists, we just update the MBID or Year if they were missing.
        const result = await db.execute({
            sql: `
                INSERT INTO albums (mbid, name, artistName, slug, releaseYear, fromUser, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(slug) DO UPDATE SET 
                    mbid = COALESCE(albums.mbid, excluded.mbid),
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
 * Ensures an album exists and has a coverArtUrl.
 * If the album exists but has no cover, it updates it.
 */
export async function syncAlbumCover(artistName: string, albumName: string, coverUrl: string, userId: string) {
    // We use the same slug generation logic to ensure consistency
    const slug = generateSlug(artistName, albumName);

    try {
        await db.execute({
            sql: `
                INSERT INTO albums (name, artistName, slug, coverArtUrl, fromUser, createdAt)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(slug) DO UPDATE SET 
                    coverArtUrl = COALESCE(albums.coverArtUrl, excluded.coverArtUrl)
            `,
            args: [albumName, artistName, slug, coverUrl, userId]
        });
    } catch (e) {
        console.error("Error syncing album cover:", e);
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
    // Only strip brackets/parens if they contain common "junk" words
    const base = albumName
        .replace(/\s*[\(\[].*?(remaster|edition|deluxe|version|anniversary|expanded).*?[\)\]]/gi, '')
        .replace(/\s*-.*?(remaster|edition|deluxe|version|anniversary|expanded).*$/gi, '')
        .trim();

    return base === '' ? albumName : base;
}

export function generateSlug(artistName: string, albumName: string, releaseYear?: string | null): string {
    const artistPart = normalizeString(artistName);
    const albumPart = normalizeString(getBaseName(albumName));

    // Logic: If we have a year, use it. 
    // This creates 'davidbowie-davidbowie-1967' and 'davidbowie-davidbowie-1969'
    const yearPart = (releaseYear && releaseYear !== "0" && releaseYear.length === 4) 
        ? `-${releaseYear}` 
        : '';
    
    return `${artistPart}-${albumPart}${yearPart}`;
}
//#endregion