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
        WITH UserStats AS (SELECT COUNT(DISTINCT userId) as totalUsers FROM ratings),
        CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
        ),
        CombinedRatings AS (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            ${dateFilter}
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT albumId, SUM(score) as sumScore, COUNT(userId) as ratingCount
            FROM CombinedRatings
            GROUP BY albumId
        )
        SELECT 
            a.name, 
            a.artistName, 
            a.slug,
            a.coverArtUrl, -- Added this
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
    const baseSlug = generateSlug(albumData.artistName, albumData.name, null);
    
    try {
        // 1. Check if this exact slug already exists
        const existing = await db.execute({
            sql: `SELECT * FROM albums WHERE slug = ?`,
            args: [slug]
        });

        if (existing.rows.length > 0) {
            const album = existing.rows[0];
            // If this entry points to a canonical ID, RETURN the canonical album instead
            // This ensures the bot pushes the new rating to the real release.
            if (album.canonicalId) {
                const canonical = await db.execute({
                    sql: `SELECT * FROM albums WHERE id = ?`,
                    args: [album.canonicalId]
                });
                if (canonical.rows.length > 0) return canonical.rows[0];
            }
            return album;
        }

        // 2. If no exact match exists AND year is missing, try to find a canonical match
        let canonicalId: number | null = null;
        let canonicalSlug: string | null = null;

        if (!albumData.releaseYear) {
            const canonicalMatch = await db.execute({
                sql: `
                    SELECT id, slug FROM albums 
                    WHERE slug LIKE ? 
                      AND releaseYear IS NOT NULL 
                      AND canonicalId IS NULL
                    ORDER BY releaseYear ASC
                    LIMIT 1
                `,
                args: [`${baseSlug}-%`] 
            });

            if (canonicalMatch.rows.length > 0) {
                canonicalId = canonicalMatch.rows[0].id as number;
                canonicalSlug = canonicalMatch.rows[0].slug as string;
            }
        }

        // 3. Insert the new album record (either standard, or pointing to a canonical ID)
        const result = await db.execute({
            sql: `
                INSERT INTO albums (mbid, name, artistName, slug, releaseYear, fromUser, canonicalId, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
                albumData.userId,
                canonicalId
            ]
        });

        // 4. If we assigned a canonicalId, return the canonical version 
        // so the caller uses the correct slug for the rating insert.
        if (canonicalSlug) {
            const canonical = await db.execute({
                sql: `SELECT * FROM albums WHERE slug = ?`,
                args: [canonicalSlug]
            });
            if (canonical.rows.length > 0) return canonical.rows[0];
        }

        return result.rows[0];
    } catch (e) {
        console.error("Error in getOrCreateAlbum:", e);
        return null;
    }
}

// Added optional releaseYear so cover art syncs properly attach to the canonical slug
export async function syncAlbumCover(artistName: string, albumName: string, coverUrl: string, userId: string, releaseYear?: string | null) {
    const slug = generateSlug(artistName, albumName, releaseYear);

    try {
        await db.execute({
            sql: `
                INSERT INTO albums (name, artistName, slug, coverArtUrl, fromUser, createdAt)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(slug) DO UPDATE SET 
                    coverArtUrl = COALESCE(albums.coverArtUrl, excluded.coverArtUrl)
            `,
            args:[albumName, artistName, slug, coverUrl, userId]
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
    const cleanQuery = query.trim().replace(/\s+/g, ' ');
    const searchTerm = `%${cleanQuery}%`;
    const looseQuery = `%${cleanQuery.replace(/\s+/g, '%')}%`;
    
    // Replaces all vowels with SQLite wildcards to effortlessly ignore accent diacritics
    // Also replaces spaces with % to allow missing punctuation
    const forgivingPattern = cleanQuery.replace(/[aeiouyAEIOUY]/g, '_').replace(/\s+/g, '%');
    const forgivingQuery = `%${forgivingPattern}%`;
    
    const words = cleanQuery.split(' ').filter(w => w.length > 0);

    const conditions: string[] =[];
    const args: string[] =[];

    // 1. SELECT clause MAX(CASE...) arguments for scoring matches
    args.push(searchTerm, searchTerm, looseQuery, searchTerm);

    // 2. Base Exactish conditions (Allows matching 'Artist Album')
    conditions.push(
        `a.name LIKE ?`,
        `a.artistName LIKE ?`,
        `a.slug LIKE ?`,
        `a.artistName || ' ' || a.name LIKE ?`,
        `a.name || ' ' || a.artistName LIKE ?`
    );
    args.push(searchTerm, searchTerm, searchTerm, looseQuery, looseQuery);

    // 3. Forgiving Accents conditions
    conditions.push(
        `a.name LIKE ?`,
        `a.artistName LIKE ?`,
        `a.slug LIKE ?`,
        `a.artistName || ' ' || a.name LIKE ?`,
        `a.name || ' ' || a.artistName LIKE ?`
    );
    args.push(forgivingQuery, forgivingQuery, forgivingQuery, forgivingQuery, forgivingQuery);

    // 4. Word-by-word chunking: Require all words to be present SOMEWHERE
    if (words.length > 1) {
        const wordConditions = words.map(() => `(a.name LIKE ? OR a.artistName LIKE ? OR a.slug LIKE ?)`);
        conditions.push(`(${wordConditions.join(' AND ')})`);
        for (const word of words) {
            // Give individual words the forgiving diacritic treatment too
            const w = `%${word.replace(/[aeiouyAEIOUY]/g, '_')}%`;
            args.push(w, w, w);
        }
    }

    const sql = `
        SELECT 
            COALESCE(c.name, a.name) as name, 
            COALESCE(c.artistName, a.artistName) as artistName, 
            COALESCE(c.slug, a.slug) as slug, 
            COALESCE(c.releaseYear, a.releaseYear) as releaseYear,
            MAX(
                CASE 
                    WHEN a.name LIKE ? THEN 100
                    WHEN a.artistName LIKE ? THEN 90
                    WHEN a.artistName || ' ' || a.name LIKE ? THEN 80
                    WHEN a.slug LIKE ? THEN 70
                    ELSE 0
                END
            ) as matchScore
        FROM albums a
        LEFT JOIN albums c ON a.canonicalId = c.id
        WHERE ${conditions.join(' OR ')}
        GROUP BY COALESCE(c.id, a.id)
        ORDER BY matchScore DESC, name ASC
        LIMIT 25
    `;

    const result = await db.execute({ sql, args });
    return result.rows as unknown as Array<{ name: string, artistName: string, slug: string, releaseYear: string | null }>;
}

export async function updateAlbumCoverArt(slug: string, url: string) {
    await db.execute({
        sql: `UPDATE albums SET coverArtUrl = ? WHERE slug = ?`,
        args:[url, slug]
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