import { db } from '@/utils/db';

// Easily adjustable minimum ratings threshold for ranking
export const MIN_RATINGS_TO_RANK = 5;
export const MIN_RATINGS_FOR_HIGHLIGHT = 5;

export interface TopAlbumResult extends AlbumStats {
    totalScore: number;
}

export interface AlbumStats {
    id: number;
    name: string;
    artistName: string;
    slug: string;
    mbid: string | null;
    releaseYear: string | null;
    coverArtUrl: string | null;
    avgScore: number | null;
    weightedScore?: number | null; // Added to support Bayesian average mapping
    ratingCount: number | null;
    rank: number | null;
}

export interface UserRating {
    userId: string;
    score: number;
    updatedAt: string;
}


export interface ArtistAlbumStat {
    name: string;
    slug: string;
    releaseYear: string | null;
    avgScore: number | null;
    weightedScore: number | null;
    ratingCount: number;
}

export interface UserRatingSearchResult {
    name: string;
    artistName: string;
    slug: string;
    releaseYear: string | null;
    userScore: number;
}

//#region Search User Ratings

/**
 * Searches a specific user's rated albums using forgiving search filtering.
 */
export async function searchUserRatings(userId: string, query: string): Promise<UserRatingSearchResult[]> {
    const cleanQuery = query.trim().replace(/\s+/g, ' ');
    if (!cleanQuery) return[];
    
    const searchTerm = `%${cleanQuery}%`;
    const looseQuery = `%${cleanQuery.replace(/\s+/g, '%')}%`;
    const words = cleanQuery.split(' ').filter(w => w.length > 0);

    const conditions: string[] =[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any[] =[];

    // The first 4 args apply to the SELECT statement's matchScore
    args.push(searchTerm, searchTerm, looseQuery, searchTerm);
    
    // The 5th arg is the target Discord User ID for the WHERE clause
    args.push(userId);

    // Standard exact/loose matches (5 items)
    conditions.push(
        `a.name LIKE ?`,
        `a.artistName LIKE ?`,
        `a.slug LIKE ?`,
        `a.artistName || ' ' || a.name LIKE ?`,
        `a.name || ' ' || a.artistName LIKE ?`
    );
    args.push(searchTerm, searchTerm, searchTerm, looseQuery, looseQuery);

    // Apply forgiving queries if the string is reasonably long
    if (cleanQuery.length >= 3) {
        const forgivingPattern = cleanQuery.replace(/[aeiouyAEIOUY]/g, '_').replace(/\s+/g, '%');
        const forgivingQuery = `%${forgivingPattern}%`;
        
        conditions.push(
            `a.name LIKE ?`,
            `a.artistName LIKE ?`,
            `a.slug LIKE ?`,
            `a.artistName || ' ' || a.name LIKE ?`,
            `a.name || ' ' || a.artistName LIKE ?`
        );
        args.push(forgivingQuery, forgivingQuery, forgivingQuery, forgivingQuery, forgivingQuery);
    }

    // Apply word splitting if the individual words are long enough
    const meaningfulWords = words.filter(w => w.length >= 3);
    if (meaningfulWords.length > 1) {
        const wordConditions = meaningfulWords.map(() => `(a.name LIKE ? OR a.artistName LIKE ? OR a.slug LIKE ?)`);
        conditions.push(`(${wordConditions.join(' AND ')})`);
        for (const word of meaningfulWords) {
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
            MAX(r.score) as userScore,
            MAX(
                CASE 
                    WHEN a.name LIKE ? THEN 100
                    WHEN a.artistName LIKE ? THEN 90
                    WHEN a.artistName || ' ' || a.name LIKE ? THEN 80
                    WHEN a.slug LIKE ? THEN 70
                    ELSE 0
                END
            ) as matchScore
        FROM ratings r
        JOIN albums a ON r.albumId = a.slug
        LEFT JOIN albums c ON a.canonicalId = c.id
        WHERE r.userId = ? AND r.score > 0 AND (${conditions.join(' OR ')})
        GROUP BY COALESCE(c.id, a.id)
        ORDER BY matchScore DESC, userScore DESC, name ASC
        LIMIT 25
    `;

    const result = await db.execute({ sql, args });
    return result.rows as unknown as UserRatingSearchResult[];
}

//#endregion

//#region Artists

/**
 * Searches unique artists from the albums table and counts their database entries
 */
export async function searchArtists(query: string) {
    const cleanQuery = query.trim().replace(/\s+/g, '%');
    if (!cleanQuery) return[];
    
    const searchTerm = `%${cleanQuery}%`;

    // Grouping by LOWER(artistName) but returning the MAX original case for visual accuracy.
    // canonicalId IS NULL prevents duplicate counts for original/canonical variants.
    const sql = `
        SELECT 
            MAX(a.artistName) as artistName,
            COUNT(DISTINCT COALESCE(a.canonicalId, a.id)) as albumCount
        FROM albums a
        WHERE a.artistName LIKE ?
        GROUP BY LOWER(a.artistName)
        ORDER BY albumCount DESC
        LIMIT 25
    `;

    const result = await db.execute({ sql, args: [searchTerm] });
    return result.rows as unknown as Array<{ artistName: string, albumCount: number }>;
}

/**
 * Retrieves an artist's discography and calculates local Bayesian scores
 */
export async function getArtistAlbums(artistName: string): Promise<ArtistAlbumStat[]> {
    const sql = `
        WITH TargetCanonicalSlugs AS (
            SELECT DISTINCT COALESCE(c.slug, a.slug) as canonical_slug,
                   COALESCE(c.name, a.name) as name,
                   COALESCE(c.releaseYear, a.releaseYear) as releaseYear
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE a.artistName = ? COLLATE NOCASE
        ),
        TargetOriginalSlugs AS (
            SELECT a.slug as original_slug, tcs.canonical_slug
            FROM albums a
            JOIN albums c ON a.canonicalId = c.id
            JOIN TargetCanonicalSlugs tcs ON c.slug = tcs.canonical_slug
            UNION
            SELECT tcs.canonical_slug as original_slug, tcs.canonical_slug
            FROM TargetCanonicalSlugs tcs
        ),
        ArtistRatings AS (
            SELECT 
                tos.canonical_slug as albumId,
                r.userId,
                MAX(r.score) as score
            FROM ratings r
            JOIN TargetOriginalSlugs tos ON r.albumId = tos.original_slug
            WHERE r.score > 0
            GROUP BY tos.canonical_slug, r.userId
        ),
        GlobalStats AS (
            -- Fast single-read approximation of global stats
            SELECT COALESCE(AVG(score), 0) as globalAvg FROM ratings WHERE score > 0
        ),
        AlbumSums AS (
            SELECT 
                ar.albumId,
                COUNT(ar.userId) as ratingCount,
                AVG(ar.score) as avgScore,
                (SUM(ar.score) + (${MIN_RATINGS_TO_RANK} * g.globalAvg)) / (COUNT(ar.userId) + ${MIN_RATINGS_TO_RANK}) as weightedScore
            FROM ArtistRatings ar
            CROSS JOIN GlobalStats g
            GROUP BY ar.albumId, g.globalAvg
        )
        SELECT 
            tcs.name,
            tcs.canonical_slug as slug,
            tcs.releaseYear,
            COALESCE(s.ratingCount, 0) as ratingCount,
            s.avgScore,
            s.weightedScore
        FROM TargetCanonicalSlugs tcs
        LEFT JOIN AlbumSums s ON tcs.canonical_slug = s.albumId
        ORDER BY 
            CASE WHEN tcs.releaseYear IS NULL THEN 0 ELSE 1 END,
            tcs.releaseYear ASC,
            tcs.name ASC
    `;

    const result = await db.execute({ sql, args: [artistName] });
    return result.rows as unknown as ArtistAlbumStat[];
}

//#endregion


/**
 * Retrieves the top rated albums with pagination and optional date filtering.
 */
export async function getTopAlbums(options: {
    page?: number;
    limit?: number;
    days?: number;
    genre?: string;
}) {
    const { page = 1, limit = 20, days, genre } = options;
    const offset = (page - 1) * limit;

    const dateFilter = days 
        ? `AND r.createdAt >= datetime('now', '-${days} days')` 
        : '';

    // Automatically drop the required ratings to 3 for genre-specific charts
    const minRatings = genre ? 3 : MIN_RATINGS_TO_RANK;

    let genreCTE = '';
    let genreJoin = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any[] =[];

    if (genre) {
        genreCTE = `
        ValidGenreAlbums AS (
            SELECT DISTINCT COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            JOIN album_genres ag ON ag.albumId = a.slug
            JOIN genres g ON ag.genreId = g.genreId
            WHERE g.genreName = ?
        ),
        `;
        genreJoin = `JOIN ValidGenreAlbums vga ON ca.canonical_slug = vga.canonical_slug`;
        args.push(genre.toLowerCase());
    }

const sql = `
        WITH CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
        ),
        ${genreCTE}
        -- MATERIALIZED forces SQLite to do this step only once and cache it in memory
        CombinedRatings AS MATERIALIZED (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            ${genreJoin}
            WHERE r.score > 0 ${dateFilter}
            GROUP BY ca.canonical_slug, r.userId
        ),
        GlobalStats AS  (
            SELECT COALESCE(CAST(SUM(score) AS FLOAT) / NULLIF(COUNT(*), 0), 0) as globalAvg
            FROM CombinedRatings
        ),
        AlbumSums AS (
            SELECT 
                c.albumId, 
                SUM(c.score) as sumScore, 
                COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                -- We get globalAvg from the CROSS JOIN below instead of a subquery
                (SUM(c.score) + (${minRatings} * g.globalAvg)) / (COUNT(c.userId) + ${minRatings}) as weightedScore
            FROM CombinedRatings c
            CROSS JOIN GlobalStats g
            GROUP BY c.albumId, g.globalAvg
        )
        SELECT 
            a.name, 
            a.artistName, 
            a.slug,
            a.coverArtUrl,
            s.ratingCount,
            s.avgScore,
            s.weightedScore
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        WHERE s.ratingCount >= ?
        ORDER BY s.weightedScore DESC, s.ratingCount DESC
        LIMIT ? OFFSET ?
    `;

    args.push(minRatings, limit, offset);
    const result = await db.execute({ sql, args });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows as any[];
}

/**
 * Retrieves highly rated albums that are just shy of the minimum ratings threshold.
 */
export async function getDonorAlbums(options: {
    page?: number;
    limit?: number;
    days?: number;
    genre?: string;
}) {
    const { page = 1, limit = 20, days, genre } = options;
    const offset = (page - 1) * limit;

    const dateFilter = days 
        ? `AND r.createdAt >= datetime('now', '-${days} days')` 
        : '';

    const minRatingsTarget = genre ? 3 : MIN_RATINGS_TO_RANK;

    let genreCTE = '';
    let genreJoin = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any[] =[];

    if (genre) {
        genreCTE = `
        ValidGenreAlbums AS (
            SELECT DISTINCT COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            JOIN album_genres ag ON ag.albumId = a.slug
            JOIN genres g ON ag.genreId = g.genreId
            WHERE g.genreName = ?
        ),
        `;
        genreJoin = `JOIN ValidGenreAlbums vga ON ca.canonical_slug = vga.canonical_slug`;
        args.push(genre.toLowerCase());
    }

const sql = `
        WITH CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
        ),
        ${genreCTE}
        CombinedRatings AS (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            ${genreJoin}
            WHERE r.score > 0 ${dateFilter}
            GROUP BY ca.canonical_slug, r.userId
        ),
        GlobalStats AS MATERIALIZED (
            SELECT COALESCE(CAST(SUM(score) AS FLOAT) / NULLIF(COUNT(*), 0), 0) as globalAvg
            FROM CombinedRatings
        ),
        AlbumSums AS (
            SELECT 
                c.albumId, 
                SUM(c.score) as sumScore, 
                COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                (SUM(c.score) + (${minRatingsTarget} * g.globalAvg)) / (COUNT(c.userId) + ${minRatingsTarget}) as weightedScore
            FROM CombinedRatings c
            CROSS JOIN GlobalStats g
            GROUP BY c.albumId, g.globalAvg
        )
        SELECT 
            a.name, 
            a.artistName, 
            a.slug,
            a.coverArtUrl,
            s.ratingCount,
            s.avgScore,
            s.weightedScore
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        WHERE s.ratingCount < ? AND s.ratingCount > 0
        ORDER BY s.ratingCount DESC, s.weightedScore DESC
        LIMIT ? OFFSET ?
    `;

    args.push(minRatingsTarget, limit, offset);

    const result = await db.execute({ sql, args });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows as any;
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
            if (album.canonicalId) {
                const canonical = await db.execute({
                    sql: `SELECT * FROM albums WHERE id = ?`,
                    args: [album.canonicalId]
                });
                if (canonical.rows.length > 0) return canonical.rows[0];
            }

            // --- SELF-HEALING LOGIC FOR EXISTING RECORDS ---
            if (!album.releaseYear) {
                // Case A: The existing album lacks a year. Check if a canonical version (with a year) exists.
                const canonicalMatch = await db.execute({
                    sql: `
                        SELECT id, slug FROM albums 
                        WHERE slug LIKE ? 
                          AND releaseYear IS NOT NULL 
                          AND canonicalId IS NULL
                          AND id != ?
                        ORDER BY releaseYear ASC
                        LIMIT 1
                    `,
                    args: [`${baseSlug}-%`, album.id] 
                });

                if (canonicalMatch.rows.length > 0) {
                    const newCanonicalId = canonicalMatch.rows[0].id as number;
                    
                    // Link this yearless album to the canonical one
                    await db.execute({
                        sql: `UPDATE albums SET canonicalId = ? WHERE id = ?`,
                        args: [newCanonicalId, album.id]
                    });
                    
                    // Return the canonical one so the user's rating attaches to the right slug
                    const canonical = await db.execute({
                        sql: `SELECT * FROM albums WHERE id = ?`,
                        args: [newCanonicalId]
                    });
                    if (canonical.rows.length > 0) return canonical.rows[0];
                }
            } else {
                // Case B: The existing album HAS a release year. 
                // Ensure any missing-year baseSlug points to it.
                await db.execute({
                    sql: `
                        UPDATE albums 
                        SET canonicalId = ? 
                        WHERE slug = ? AND canonicalId IS NULL AND id != ?
                    `,
                    args: [album.id, baseSlug, album.id]
                });
            }

            return album;
        }

        // 2. If no exact match exists AND year is missing, try to find a canonical match beforehand
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

        // 3. Insert the new album record
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

        const savedAlbum = result.rows[0];

        // 4. Backwards healing: If we just inserted a new album WITH a releaseYear, 
        // ensure any existing yearless base slug is caught and linked to it.
        if (savedAlbum.releaseYear && !canonicalId) {
            await db.execute({
                sql: `
                    UPDATE albums 
                    SET canonicalId = ? 
                    WHERE slug = ? AND canonicalId IS NULL AND id != ?
                `,
                args:[savedAlbum.id, baseSlug, savedAlbum.id]
            });
        }

        // 5. If we assigned a canonicalId during insert, return the canonical version
        if (canonicalSlug) {
            const canonical = await db.execute({
                sql: `SELECT * FROM albums WHERE slug = ?`,
                args: [canonicalSlug]
            });
            if (canonical.rows.length > 0) return canonical.rows[0];
        }

        return savedAlbum;
    } catch (e) {
        console.error("Error in getOrCreateAlbum:", e);
        return null;
    }
}


export async function getAlbumById(id: number) {
    const sql = `SELECT * FROM albums WHERE id = ?`;
    const result = await db.execute({ sql, args: [id] });
    return result.rows.length > 0 ? result.rows[0] : null;
}



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

export async function getAlbumWithStats(slug: string): Promise<AlbumStats | null> {
const sql = `
        WITH CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM ratings r2
            JOIN albums a ON r2.albumId = a.slug
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE r2.score > 0
            GROUP BY a.slug
        ),
        CombinedRatings AS (
            SELECT 
                ca.canonical_slug as albumId,
                r.userId,
                MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            WHERE r.score > 0
            GROUP BY ca.canonical_slug, r.userId
        ),
        GlobalStats AS  (
            SELECT COALESCE(CAST(SUM(score) AS FLOAT) / NULLIF(COUNT(*), 0), 0) as globalAvg
            FROM CombinedRatings
        ),
        AlbumSums AS (
            SELECT 
                c.albumId, 
                SUM(c.score) as sumScore, 
                COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                (SUM(c.score) + (${MIN_RATINGS_TO_RANK} * g.globalAvg)) / (COUNT(c.userId) + ${MIN_RATINGS_TO_RANK}) as weightedScore
            FROM CombinedRatings c
            CROSS JOIN GlobalStats g
            GROUP BY c.albumId, g.globalAvg
        ),
        RankedAlbums AS (
            SELECT 
                albumId, 
                RANK() OVER(
                    ORDER BY weightedScore DESC, ratingCount DESC
                ) as rank
            FROM AlbumSums
            WHERE ratingCount >= ?
        ),
        TargetAlbum AS (
            SELECT COALESCE(c.slug, a.slug) as target_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE a.slug = ? OR (LENGTH(?) >= 95 AND a.slug LIKE ?)
            LIMIT 1
        )
        SELECT 
            a.id, a.name, a.artistName, a.slug, a.mbid, a.releaseYear, a.coverArtUrl,
            s.avgScore, s.weightedScore, s.ratingCount, r.rank
        FROM albums a
        JOIN TargetAlbum t ON a.slug = t.target_slug
        LEFT JOIN AlbumSums s ON a.slug = s.albumId
        LEFT JOIN RankedAlbums r ON a.slug = r.albumId
    `;
    const result = await db.execute({ sql, args:[MIN_RATINGS_TO_RANK, slug, slug, slug + '%'] });
    if (result.rows.length === 0) return null;
    
    return result.rows[0] as unknown as AlbumStats;
}

/**
 * Searches albums by name, artist, or slug, combining duplicates.
 */
export async function searchAlbums(query: string) {
    const cleanQuery = query.trim().replace(/\s+/g, ' ');
    if (!cleanQuery) return[];
    
    const searchTerm = `%${cleanQuery}%`;
    const looseQuery = `%${cleanQuery.replace(/\s+/g, '%')}%`;
    const words = cleanQuery.split(' ').filter(w => w.length > 0);

    const conditions: string[] =[];
    const args: string[] =[];

    // The first 4 args apply to the SELECT statement's matchScore
    args.push(searchTerm, searchTerm, looseQuery, searchTerm);

    // Standard exact/loose matches (5 items)
    conditions.push(
        `a.name LIKE ?`,
        `a.artistName LIKE ?`,
        `a.slug LIKE ?`,
        `a.artistName || ' ' || a.name LIKE ?`,
        `a.name || ' ' || a.artistName LIKE ?`
    );
    args.push(searchTerm, searchTerm, searchTerm, looseQuery, looseQuery);

    // FIX: Only do forgiving queries if the string is reasonably long.
    // This prevents catastrophic wildcard matches like `%__%` or `%x_%` which crash SQLite.
    if (cleanQuery.length >= 3) {
        const forgivingPattern = cleanQuery.replace(/[aeiouyAEIOUY]/g, '_').replace(/\s+/g, '%');
        const forgivingQuery = `%${forgivingPattern}%`;
        
        conditions.push(
            `a.name LIKE ?`,
            `a.artistName LIKE ?`,
            `a.slug LIKE ?`,
            `a.artistName || ' ' || a.name LIKE ?`,
            `a.name || ' ' || a.artistName LIKE ?`
        );
        args.push(forgivingQuery, forgivingQuery, forgivingQuery, forgivingQuery, forgivingQuery);
    }

    // FIX: Only apply word splitting if the individual words are long enough
    const meaningfulWords = words.filter(w => w.length >= 3);
    if (meaningfulWords.length > 1) {
        const wordConditions = meaningfulWords.map(() => `(a.name LIKE ? OR a.artistName LIKE ? OR a.slug LIKE ?)`);
        conditions.push(`(${wordConditions.join(' AND ')})`);
        for (const word of meaningfulWords) {
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
            -- ADDED: Support truncated slugs
            WHERE a.slug = ? OR (LENGTH(?) >= 95 AND a.slug LIKE ?)
            LIMIT 1
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
        WHERE r.score > 0
        GROUP BY r.userId
        ORDER BY score DESC
    `;
    
    // ADDED: Pass the extra params
    const result = await db.execute({ sql, args: [slug, slug, slug + '%'] });
    return result.rows as unknown as UserRating[];
}

export async function canonizeAlbum(targetSlug: string, canonSlug: string): Promise<{ success: boolean; message: string }> {
    if (targetSlug === canonSlug) {
        return { success: false, message: "Target and canonical slugs cannot be the same." };
    }

    try {
        const canonRes = await db.execute({
            sql: `SELECT id, canonicalId FROM albums WHERE slug = ?`,
            args: [canonSlug]
        });
        
        if (canonRes.rows.length === 0) {
            return { success: false, message: `Canonical album \`${canonSlug}\` not found in the database.` };
        }
        
        const canonId = (canonRes.rows[0].canonicalId || canonRes.rows[0].id) as number;

        const targetRes = await db.execute({
            sql: `SELECT id, canonicalId FROM albums WHERE slug = ?`,
            args: [targetSlug]
        });
        
        if (targetRes.rows.length === 0) {
            return { success: false, message: `Target album \`${targetSlug}\` not found in the database.` };
        }
        
        const targetId = targetRes.rows[0].id as number;

        if (canonId === targetId || canonId === targetRes.rows[0].canonicalId) {
            return { success: false, message: "These slugs already resolve to the same canonical album." };
        }

        await db.execute({
            sql: `UPDATE albums SET canonicalId = ? WHERE id = ?`,
            args: [canonId, targetId]
        });

        await db.execute({
            sql: `UPDATE albums SET canonicalId = ? WHERE canonicalId = ?`,
            args: [canonId, targetId]
        });

        return { success: true, message: `Successfully linked \`${targetSlug}\` to canonical album \`${canonSlug}\`.` };
    } catch (error) {
        console.error("Error in canonizeAlbum:", error);
        return { success: false, message: "A database error occurred while trying to canonize the album." };
    }
}

export async function canonizeAlbumById(targetId: number, canonId: number): Promise<{ success: boolean; message: string }> {
    if (targetId === canonId) {
        return { success: false, message: "Target and canonical IDs cannot be the same." };
    }

    try {
        // Find the Canonical Album to ensure it exists and to resolve its own ultimate canonical ID
        const canonRes = await db.execute({
            sql: `SELECT id, canonicalId FROM albums WHERE id = ?`,
            args: [canonId]
        });
        
        if (canonRes.rows.length === 0) {
            return { success: false, message: `Canonical album ID \`${canonId}\` not found in the database.` };
        }
        
        // Resolve the ultimate canonical ID (in case the provided canonId is already linked to another)
        const resolvedCanonId = (canonRes.rows[0].canonicalId || canonRes.rows[0].id) as number;

        // Find the Target Album to ensure it exists
        const targetRes = await db.execute({
            sql: `SELECT id, canonicalId FROM albums WHERE id = ?`,
            args:[targetId]
        });
        
        if (targetRes.rows.length === 0) {
            return { success: false, message: `Target album ID \`${targetId}\` not found in the database.` };
        }

        // Check if they are already pointing to the same place
        if (resolvedCanonId === targetId || resolvedCanonId === targetRes.rows[0].canonicalId) {
            return { success: false, message: "These IDs already resolve to the same canonical album." };
        }

        // Update the target album to point to the resolved canonical ID
        await db.execute({
            sql: `UPDATE albums SET canonicalId = ? WHERE id = ?`,
            args: [resolvedCanonId, targetId]
        });

        // Update any other albums that were previously pointing to the target album
        await db.execute({
            sql: `UPDATE albums SET canonicalId = ? WHERE canonicalId = ?`,
            args:[resolvedCanonId, targetId]
        });

        return { success: true, message: `Successfully linked album ID \`${targetId}\` to canonical album ID \`${canonId}\`.` };
    } catch (error) {
        console.error("Error in canonizeAlbumById:", error);
        return { success: false, message: "A database error occurred while trying to canonize the album." };
    }
}

export async function getRandomTopUnhighlightedAlbum(topLimit: number): Promise<string | null> {
    try {
const sql = `
            WITH CanonicalAlbums AS (
                SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
                FROM ratings r2
                JOIN albums a ON r2.albumId = a.slug
                LEFT JOIN albums c ON a.canonicalId = c.id
                WHERE r2.score > 0
                GROUP BY a.slug
            ),
            CombinedRatings AS MATERIALIZED (
                SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
                FROM ratings r
                JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
                WHERE r.score > 0
                GROUP BY ca.canonical_slug, r.userId
            ),
            GlobalStats AS MATERIALIZED (
                SELECT COALESCE(CAST(SUM(score) AS FLOAT) / NULLIF(COUNT(*), 0), 0) as globalAvg
                FROM CombinedRatings
            ),
            AlbumSums AS (
                SELECT 
                    c.albumId, 
                    COUNT(c.userId) as ratingCount,
                    (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                    (SUM(c.score) + (${MIN_RATINGS_FOR_HIGHLIGHT} * g.globalAvg)) / (COUNT(c.userId) + ${MIN_RATINGS_FOR_HIGHLIGHT}) as weightedScore
                FROM CombinedRatings c
                CROSS JOIN GlobalStats g
                GROUP BY c.albumId, g.globalAvg
            ),
            EligibleTopAlbums AS (
                SELECT 
                    s.albumId as slug
                FROM AlbumSums s
                JOIN albums a ON s.albumId = a.slug
                WHERE 
                    s.ratingCount >= ? 
                    AND a.albumHighlight IS NULL 
                ORDER BY 
                    s.weightedScore DESC, s.ratingCount DESC 
                LIMIT ? 
            )
            SELECT slug FROM EligibleTopAlbums ORDER BY RANDOM() LIMIT 1;
        `;
        const args = [MIN_RATINGS_FOR_HIGHLIGHT, topLimit];
        const result = await db.execute({ sql, args });
        
        if (result.rows.length === 0) {
            console.warn("[DB] getRandomTopUnhighlightedAlbum found no eligible albums matching the criteria.");
            return null;
        }
        return result.rows[0].slug as string;

    } catch (e) {
        console.error("[DB] FATAL ERROR in getRandomTopUnhighlightedAlbum:", e);
        throw e;
    }
}

/**
 * Marks an album as highlighted with the current datetime.
 */
export async function markAlbumAsHighlighted(slug: string) {
    await db.execute({
        sql: `UPDATE albums SET albumHighlight = CURRENT_TIMESTAMP WHERE slug = ?`,
        args: [slug]
    });
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