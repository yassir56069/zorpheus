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

    const dateFilter = days 
        ? `WHERE r.createdAt >= datetime('now', '-${days} days')` 
        : '';

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
            -- Combine ratings of duplicate albums. If a user rated both, we safely take the MAX score to prevent double-voting.
            SELECT 
                ca.canonical_slug as albumId,
                r.userId,
                MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            ${dateFilter}
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT 
                albumId, 
                SUM(score) as sumScore, 
                COUNT(userId) as ratingCount
            FROM CombinedRatings
            GROUP BY albumId
        )
        SELECT 
            a.name, 
            a.artistName, 
            a.slug,
            s.ratingCount,
            (CAST(s.sumScore AS FLOAT) / NULLIF((SELECT totalUsers FROM UserStats), 0)) / 2.0 as weightedScore
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        ORDER BY weightedScore DESC
        LIMIT ? OFFSET ?
    `;

    const result = await db.execute({ sql, args: [limit, offset] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows as any[];
}

export async function getOrCreateAlbum(albumData: {
    name: string;
    artistName: string;
    mbid?: string | null;
    releaseYear?: string | null;
    userId: string;
}) {
    const slug = generateSlug(albumData.artistName, albumData.name, albumData.releaseYear);
    
    try {
        const result = await db.execute({
            sql: `
                INSERT INTO albums (mbid, name, artistName, slug, releaseYear, fromUser, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(slug) DO UPDATE SET 
                    mbid = COALESCE(albums.mbid, excluded.mbid),
                    releaseYear = COALESCE(albums.releaseYear, excluded.releaseYear)
                RETURNING *
            `,
            args:[
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

export async function syncAlbumCover(artistName: string, albumName: string, coverUrl: string, userId: string) {
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
 * rating count, and overall ranking among all albums (including merged ones).
 */
export async function getAlbumWithStats(slug: string): Promise<AlbumStats | null> {
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
            SELECT 
                ca.canonical_slug as albumId,
                r.userId,
                MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT 
                albumId, 
                SUM(score) as sumScore, 
                COUNT(userId) as ratingCount
            FROM CombinedRatings 
            GROUP BY albumId
        ),
        RankedAlbums AS (
            SELECT 
                albumId, 
                (CAST(sumScore AS FLOAT) / NULLIF((SELECT totalUsers FROM UserStats), 0)) as avgScore, 
                ratingCount, 
                RANK() OVER(
                    ORDER BY (CAST(sumScore AS FLOAT) / NULLIF((SELECT totalUsers FROM UserStats), 0)) DESC, ratingCount DESC
                ) as rank
            FROM AlbumSums
        ),
        TargetAlbum AS (
            -- Finds the canonical slug regardless of whether the user queried the duplicate or the canonical album
            SELECT COALESCE(c.slug, a.slug) as target_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE a.slug = ?
        )
        SELECT 
            a.name, a.artistName, a.slug, a.mbid, a.releaseYear, a.coverArtUrl,
            r.avgScore, r.ratingCount, r.rank
        FROM albums a
        JOIN TargetAlbum t ON a.slug = t.target_slug
        LEFT JOIN RankedAlbums r ON a.slug = r.albumId
    `;

    const result = await db.execute({ sql, args: [slug] });
    if (result.rows.length === 0) return null;
    
    return result.rows[0] as unknown as AlbumStats;
}

/**
 * Searches albums by name, artist, or slug, combining duplicates.
 */
export async function searchAlbums(query: string) {
    const searchTerm = `%${query}%`;
    const sql = `
        SELECT 
            COALESCE(c.name, a.name) as name, 
            COALESCE(c.artistName, a.artistName) as artistName, 
            COALESCE(c.slug, a.slug) as slug, 
            COALESCE(c.releaseYear, a.releaseYear) as releaseYear
        FROM albums a
        LEFT JOIN albums c ON a.canonicalId = c.id
        WHERE a.name LIKE ? OR a.artistName LIKE ? OR a.slug LIKE ?
        GROUP BY COALESCE(c.id, a.id)
        LIMIT 25
    `;
    const result = await db.execute({ sql, args:[searchTerm, searchTerm, searchTerm] });
    return result.rows as unknown as Array<{ name: string, artistName: string, slug: string, releaseYear: string | null }>;
}

export async function updateAlbumCoverArt(slug: string, url: string) {
    await db.execute({
        sql: `UPDATE albums SET coverArtUrl = ? WHERE slug = ?`,
        args: [url, slug]
    });
}

/**
 * Gets all user ratings for a specific album, combining canonical and duplicate ratings.
 */
export async function getAlbumRatings(slug: string): Promise<UserRating[]> {
    const sql = `
        WITH TargetAlbum AS (
            SELECT COALESCE(c.slug, a.slug) as target_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE a.slug = ?
        ),
        CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
        )
        SELECT 
            r.userId, 
            MAX(r.score) as score, 
            MAX(r.updatedAt) as updatedAt
        FROM ratings r
        JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
        JOIN TargetAlbum t ON ca.canonical_slug = t.target_slug
        GROUP BY r.userId
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
        .replace(/\s*[\(\[].*?(remaster|edition|deluxe|version|anniversary|expanded).*?[\)\]]/gi, '')
        .replace(/\s*-.*?(remaster|edition|deluxe|version|anniversary|expanded).*$/gi, '')
        .trim();

    return base === '' ? albumName : base;
}

export function generateSlug(artistName: string, albumName: string, releaseYear?: string | null): string {
    const artistPart = normalizeString(artistName);
    const albumPart = normalizeString(getBaseName(albumName));

    const yearPart = (releaseYear && releaseYear !== "0" && releaseYear.length === 4) 
        ? `-${releaseYear}` 
        : '';
    
    return `${artistPart}-${albumPart}${yearPart}`;
}
//#endregion