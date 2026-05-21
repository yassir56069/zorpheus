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

//#region Global Stats

/**
 * Retrieves the cached global average rating, updating it if it's older than 1 hour.
 */
async function getGlobalAverage(): Promise<number> {
    try {
        const cacheRes = await db.execute({
            sql: `SELECT value, (julianday('now') - julianday(updatedAt)) * 24 as hoursOld FROM system_stats WHERE key = 'global_rating_avg' LIMIT 1`,
            args: []
        });

        const cache = cacheRes.rows[0];
        
        // Let SQLite handle the date math to prevent JS "Invalid Date" parsing errors
        if (!cache || (cache.hoursOld as number) > 1) {
            const refreshRes = await db.execute({
                sql: `SELECT AVG(score) as newAvg FROM ratings WHERE score > 0`,
                args: []
            });
            
            const newAvg = (refreshRes.rows[0]?.newAvg as number) || 7.0;

            await db.execute({
                sql: `INSERT INTO system_stats (key, value, updatedAt) 
                      VALUES ('global_rating_avg', ?, CURRENT_TIMESTAMP)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP`,
                args: [newAvg]
            });
            return newAvg;
        }

        return cache.value as number;
    } catch (e) {
        console.error("Error fetching global average:", e);
        return 7.0;
    }
}

/**
 * The "Lazy Cron Job" caching mechanism.
 * If 1 hour has passed, this recalculates the ranks for ALL albums and saves 
 * them to a dedicated 'album_ranking_cache' table. 
 */
async function ensureAlbumRankingsCache(): Promise<boolean> {
    const globalAvg = await getGlobalAverage();
    
    try {
        const cacheRes = await db.execute({
            sql: `SELECT value, (julianday('now') - julianday(updatedAt)) * 24 as hoursOld FROM system_stats WHERE key = 'album_rankings_cache' LIMIT 1`,
            args: []
        });

        const cache = cacheRes.rows[0];
        
        if (!cache || (cache.hoursOld as number) > 1) {
            // 1. Ensure cache table exists
            await db.execute({
                sql: `CREATE TABLE IF NOT EXISTS album_ranking_cache (
                    slug TEXT PRIMARY KEY,
                    ratingCount INTEGER,
                    avgScore REAL,
                    weightedScore REAL,
                    rank INTEGER
                )`,
                args: []
            });

            // 2. Perform the heavy calculation ONCE and REPLACE into the cache table.
            await db.execute({
                sql: `
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
                            c.albumId, 
                            COUNT(c.userId) as ratingCount,
                            (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                            (SUM(c.score) + (${MIN_RATINGS_TO_RANK} * ${globalAvg})) / (COUNT(c.userId) + ${MIN_RATINGS_TO_RANK}) as weightedScore
                        FROM CombinedRatings c
                        GROUP BY c.albumId
                    ),
                    RankedAlbums AS (
                        SELECT 
                            albumId,
                            ratingCount,
                            avgScore,
                            weightedScore,
                            RANK() OVER(ORDER BY weightedScore DESC, ratingCount DESC) as rank
                        FROM AlbumSums
                        WHERE ratingCount >= ${MIN_RATINGS_TO_RANK}
                    )
                    INSERT OR REPLACE INTO album_ranking_cache (slug, ratingCount, avgScore, weightedScore, rank)
                    SELECT albumId, ratingCount, avgScore, weightedScore, rank FROM RankedAlbums;
                `,
                args: []
            });

            // 3. Clean up any albums that dropped below the threshold
            await db.execute({
                sql: `DELETE FROM album_ranking_cache WHERE ratingCount < ?`,
                args: [MIN_RATINGS_TO_RANK]
            });

            // 4. Update the 'last run' timestamp
            await db.execute({
                sql: `INSERT INTO system_stats (key, value, updatedAt) 
                      VALUES ('album_rankings_cache', '1', CURRENT_TIMESTAMP)
                      ON CONFLICT(key) DO UPDATE SET updatedAt = CURRENT_TIMESTAMP`,
                args: []
            });
        }
        return true;
    } catch (e) {
        console.error("Error refreshing album rankings cache:", e);
        return false;
    }
}

/**
 * Calculates ratings immediately for ONE specific album and instantly shifts the entire 
 * leaderboard rankings. Very lightweight for DB usage, providing real-time UI updates!
 */
export async function updateSingleAlbumCache(slug: string) {
    await ensureAlbumRankingsCache();
    const globalAvg = await getGlobalAverage();

    try {
        await db.execute({
            sql: `
                WITH TargetAlbum AS (
                    SELECT COALESCE(c.slug, a.slug) as canonical_slug
                    FROM albums a
                    LEFT JOIN albums c ON a.canonicalId = c.id
                    WHERE a.slug = ?
                    LIMIT 1
                ),
                AlbumRatings AS (
                    SELECT r.userId, MAX(r.score) as score
                    FROM ratings r
                    JOIN albums a ON r.albumId = a.slug
                    LEFT JOIN albums c ON a.canonicalId = c.id
                    JOIN TargetAlbum t ON COALESCE(c.slug, a.slug) = t.canonical_slug
                    WHERE r.score > 0
                    GROUP BY r.userId
                )
                INSERT OR REPLACE INTO album_ranking_cache (slug, ratingCount, avgScore, weightedScore, rank)
                SELECT 
                    (SELECT canonical_slug FROM TargetAlbum),
                    COUNT(userId),
                    (CAST(SUM(score) AS FLOAT) / COUNT(userId)),
                    (SUM(score) + (${MIN_RATINGS_TO_RANK} * ${globalAvg})) / (COUNT(userId) + ${MIN_RATINGS_TO_RANK}),
                    COALESCE((SELECT rank FROM album_ranking_cache WHERE slug = (SELECT canonical_slug FROM TargetAlbum)), 999999)
                FROM AlbumRatings
                HAVING COUNT(userId) >= ${MIN_RATINGS_TO_RANK};
            `,
            args: [slug]
        });

        // Clean up if someone deleted a rating and dropped it below threshold
        await db.execute({
            sql: `DELETE FROM album_ranking_cache WHERE slug IN (
                    SELECT COALESCE(c.slug, a.slug) FROM albums a LEFT JOIN albums c ON a.canonicalId = c.id WHERE a.slug = ?
                  ) AND ratingCount < ?`,
            args: [slug, MIN_RATINGS_TO_RANK]
        });

        // Lightning-fast re-rank of the entire table based on the new aggregated score!
        await db.execute({
            sql: `
                UPDATE album_ranking_cache
                SET rank = ReRanked.newRank
                FROM (
                    SELECT slug, RANK() OVER(ORDER BY weightedScore DESC, ratingCount DESC) as newRank
                    FROM album_ranking_cache
                ) AS ReRanked
                WHERE album_ranking_cache.slug = ReRanked.slug;
            `,
            args: []
        });
    } catch (e) {
        console.error("[CACHE] Error updating single album cache:", e);
    }
}

/**
 * Triggers a full rebuild the next time rankings are queried.
 */
export async function invalidateAlbumRankingsCache() {
    try {
        await db.execute({
            sql: `UPDATE system_stats SET updatedAt = '1970-01-01' WHERE key = 'album_rankings_cache'`,
            args: []
        });
    } catch (e) {
        console.error("[CACHE] Error invalidating album cache:", e);
    }
}

//#endregion

//#region Search User Ratings

export async function searchUserRatings(userId: string, query: string): Promise<UserRatingSearchResult[]> {
    const cleanQuery = query.trim().replace(/\s+/g, ' ');
    if (!cleanQuery) return[];
    
    const searchTerm = `%${cleanQuery}%`;
    const looseQuery = `%${cleanQuery.replace(/\s+/g, '%')}%`;
    const words = cleanQuery.split(' ').filter(w => w.length > 0);

    const conditions: string[] =[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any[] =[];

    args.push(searchTerm, searchTerm, looseQuery, searchTerm);
    args.push(userId);

    conditions.push(
        `a.name LIKE ?`,
        `a.artistName LIKE ?`,
        `a.slug LIKE ?`,
        `a.artistName || ' ' || a.name LIKE ?`,
        `a.name || ' ' || a.artistName LIKE ?`
    );
    args.push(searchTerm, searchTerm, searchTerm, looseQuery, looseQuery);

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


//#region  User Rating Server Chart
/**
 * Retrieves the top rated albums on the server that a specific user HAS NOT rated yet.
 */
export async function getTopUnratedAlbums(userId: string, options: {
    page?: number;
    limit?: number;
    days?: number;
    genre?: string;
}) {
    const { page = 1, limit = 20, days, genre } = options;
    const offset = (page - 1) * limit;

    // Fast cache path
    if (!days && !genre) {
        const cacheReady = await ensureAlbumRankingsCache();
        if (cacheReady) {
            const sql = `
                WITH CanonicalAlbums AS (
                    SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
                    FROM albums a
                    LEFT JOIN albums c ON a.canonicalId = c.id
                ),
                UserRatedAlbums AS (
                    SELECT DISTINCT ca.canonical_slug
                    FROM ratings r
                    JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
                    WHERE r.userId = ?
                )
                SELECT 
                    a.name, a.artistName, a.slug, a.coverArtUrl,
                    c.ratingCount, c.avgScore, c.weightedScore, c.rank as serverRank
                FROM album_ranking_cache c
                JOIN albums a ON c.slug = a.slug
                LEFT JOIN UserRatedAlbums ura ON c.slug = ura.canonical_slug
                WHERE ura.canonical_slug IS NULL
                ORDER BY c.rank ASC
                LIMIT ? OFFSET ?
            `;
            const result = await db.execute({ sql, args: [userId, limit, offset] });
            
            // If we found results OR if we are paging deep into the list, return.
            // If page=1 and rows=0, it means the cache somehow failed/is empty. We drop to the fallback!
            if (result.rows.length > 0 || page > 1) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return result.rows as any[];
            }
        }
    }

    // Dynamic fallback for queries with filters, or if the cache is unexpectedly empty
    const globalAvg = await getGlobalAverage(); 

    const dateFilter = days ? `AND r.createdAt >= datetime('now', '-${days} days')` : '';
    const minRatings = genre ? 3 : MIN_RATINGS_TO_RANK;

    let genreCTE = '';
    let genreJoin = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any[] = [userId];

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
        UserRatedAlbums AS (
            SELECT DISTINCT ca.canonical_slug
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            WHERE r.userId = ?
        ),
        ${genreCTE}
        CombinedRatings AS MATERIALIZED (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            ${genreJoin}
            WHERE r.score > 0 ${dateFilter}
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT 
                c.albumId, 
                SUM(c.score) as sumScore, 
                COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                (SUM(c.score) + (${minRatings} * ${globalAvg})) / (COUNT(c.userId) + ${minRatings}) as weightedScore
            FROM CombinedRatings c
            GROUP BY c.albumId
        ),
        RankedAlbums AS (
            SELECT 
                albumId, ratingCount, avgScore, weightedScore,
                RANK() OVER(ORDER BY weightedScore DESC, ratingCount DESC) as serverRank
            FROM AlbumSums
            WHERE ratingCount >= ?
        )
        SELECT 
            a.name, a.artistName, a.slug, a.coverArtUrl,
            r.ratingCount, r.avgScore, r.weightedScore, r.serverRank
        FROM RankedAlbums r
        JOIN albums a ON r.albumId = a.slug
        LEFT JOIN UserRatedAlbums ura ON r.albumId = ura.canonical_slug
        WHERE ura.canonical_slug IS NULL
        ORDER BY r.serverRank ASC
        LIMIT ? OFFSET ?
    `;

    args.push(minRatings, limit, offset);
    const result = await db.execute({ sql, args });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows as any[];
}

//#region Artists

export async function searchArtists(query: string) {
    const cleanQuery = query.trim().replace(/\s+/g, '%');
    if (!cleanQuery) return[];
    
    const searchTerm = `%${cleanQuery}%`;

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

export async function getArtistAlbums(artistName: string): Promise<ArtistAlbumStat[]> {
    const globalAvg = await getGlobalAverage();

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
        AlbumSums AS (
            SELECT 
                ar.albumId,
                COUNT(ar.userId) as ratingCount,
                AVG(ar.score) as avgScore,
                (SUM(ar.score) + (${MIN_RATINGS_TO_RANK} * ${globalAvg})) / (COUNT(ar.userId) + ${MIN_RATINGS_TO_RANK}) as weightedScore
            FROM ArtistRatings ar
            GROUP BY ar.albumId
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

    // Fast Cache path
    if (!days && !genre) {
        const cacheReady = await ensureAlbumRankingsCache();
        if (cacheReady) {
            const sql = `
                SELECT 
                    a.name, a.artistName, a.slug, a.coverArtUrl,
                    c.ratingCount, c.avgScore, c.weightedScore
                FROM album_ranking_cache c
                JOIN albums a ON c.slug = a.slug
                ORDER BY c.rank ASC
                LIMIT ? OFFSET ?
            `;
            const result = await db.execute({ sql, args: [limit, offset] });
            
            // Seamless dynamic fallback if cache is empty unexpectedly
            if (result.rows.length > 0 || page > 1) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return result.rows as any[];
            }
        }
    }
    
    // Dynamic fallback for queries with filters, or if cache failed/was empty
    const globalAvg = await getGlobalAverage(); 

    const dateFilter = days ? `AND r.createdAt >= datetime('now', '-${days} days')` : '';
    const minRatings = genre ? 3 : MIN_RATINGS_TO_RANK;

    let genreCTE = '';
    let genreJoin = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any[] = [];

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
        CombinedRatings AS MATERIALIZED (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            ${genreJoin}
            WHERE r.score > 0 ${dateFilter}
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT 
                c.albumId, 
                SUM(c.score) as sumScore, 
                COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                (SUM(c.score) + (${minRatings} * ${globalAvg})) / (COUNT(c.userId) + ${minRatings}) as weightedScore
            FROM CombinedRatings c
            GROUP BY c.albumId
        )
        SELECT 
            a.name, a.artistName, a.slug, a.coverArtUrl,
            s.ratingCount, s.avgScore, s.weightedScore
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

export async function getDonorAlbums(options: {
    page?: number;
    limit?: number;
    days?: number;
    genre?: string;
}) {
    const { page = 1, limit = 20, days, genre } = options;
    const offset = (page - 1) * limit;
    
    const globalAvg = await getGlobalAverage();

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
        AlbumSums AS (
            SELECT 
                c.albumId, 
                SUM(c.score) as sumScore, 
                COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                (SUM(c.score) + (${minRatingsTarget} * ${globalAvg})) / (COUNT(c.userId) + ${minRatingsTarget}) as weightedScore
            FROM CombinedRatings c
            GROUP BY c.albumId
        )
        SELECT 
            a.name, a.artistName, a.slug, a.coverArtUrl,
            s.ratingCount, s.avgScore, s.weightedScore
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
        const existing = await db.execute({
            sql: `SELECT * FROM albums WHERE slug = ?`,
            args: [slug]
        });

        if (existing.rows.length > 0) {
            const album = existing.rows[0];
            
            if (album.canonicalId) {
                const canonical = await db.execute({
                    sql: `SELECT * FROM albums WHERE id = ?`,
                    args: [album.canonicalId]
                });
                if (canonical.rows.length > 0) return canonical.rows[0];
            }

            if (!album.releaseYear) {
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
                    
                    await db.execute({
                        sql: `UPDATE albums SET canonicalId = ? WHERE id = ?`,
                        args: [newCanonicalId, album.id]
                    });
                    
                    const canonical = await db.execute({
                        sql: `SELECT * FROM albums WHERE id = ?`,
                        args: [newCanonicalId]
                    });
                    if (canonical.rows.length > 0) return canonical.rows[0];
                }
            } else {
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
    const cacheReady = await ensureAlbumRankingsCache();

    if (cacheReady) {
        const sql = `
            WITH TargetAlbum AS (
                SELECT COALESCE(c.slug, a.slug) as target_slug
                FROM albums a
                LEFT JOIN albums c ON a.canonicalId = c.id
                WHERE a.slug = ? OR (LENGTH(?) >= 95 AND a.slug LIKE ?)
                LIMIT 1
            )
            SELECT 
                a.id, a.name, a.artistName, a.slug, a.mbid, a.releaseYear, a.coverArtUrl,
                s.avgScore, s.weightedScore, s.ratingCount, s.rank
            FROM albums a
            JOIN TargetAlbum t ON a.slug = t.target_slug
            LEFT JOIN album_ranking_cache s ON a.slug = s.slug
        `;
        const result = await db.execute({ sql, args:[slug, slug, slug + '%'] });
        
        // If we found it and it's ranked, return it. Unranked albums fall through gracefully.
        if (result.rows.length > 0 && result.rows[0].rank != null) {
            return result.rows[0] as unknown as AlbumStats;
        }
    }

    // Dynamic fallback
    const globalAvg = await getGlobalAverage();
    const fallbackSql = `
        WITH CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM ratings r2
            JOIN albums a ON r2.albumId = a.slug
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE r2.score > 0
            GROUP BY a.slug
        ),
        CombinedRatings AS (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            WHERE r.score > 0
            GROUP BY ca.canonical_slug, r.userId
        ),
        AlbumSums AS (
            SELECT c.albumId, COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                (SUM(c.score) + (${MIN_RATINGS_TO_RANK} * ${globalAvg})) / (COUNT(c.userId) + ${MIN_RATINGS_TO_RANK}) as weightedScore
            FROM CombinedRatings c
            GROUP BY c.albumId
        ),
        RankedAlbums AS (
            SELECT albumId, RANK() OVER(ORDER BY weightedScore DESC, ratingCount DESC) as rank
            FROM AlbumSums WHERE ratingCount >= ?
        ),
        TargetAlbum AS (
            SELECT COALESCE(c.slug, a.slug) as target_slug FROM albums a
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
    const fallbackRes = await db.execute({ sql: fallbackSql, args:[MIN_RATINGS_TO_RANK, slug, slug, slug + '%'] });
    if (fallbackRes.rows.length === 0) return null;
    return fallbackRes.rows[0] as unknown as AlbumStats;
}

export async function searchAlbums(query: string) {
    const cleanQuery = query.trim().replace(/\s+/g, ' ');
    if (!cleanQuery) return[];
    
    const searchTerm = `%${cleanQuery}%`;
    const looseQuery = `%${cleanQuery.replace(/\s+/g, '%')}%`;
    const words = cleanQuery.split(' ').filter(w => w.length > 0);

    const conditions: string[] =[];
    const args: string[] =[];

    args.push(searchTerm, searchTerm, looseQuery, searchTerm);

    conditions.push(
        `a.name LIKE ?`,
        `a.artistName LIKE ?`,
        `a.slug LIKE ?`,
        `a.artistName || ' ' || a.name LIKE ?`,
        `a.name || ' ' || a.artistName LIKE ?`
    );
    args.push(searchTerm, searchTerm, searchTerm, looseQuery, looseQuery);

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

export async function getAlbumRatings(slug: string): Promise<UserRating[]> {
    const sql = `
        WITH TargetAlbum AS (
            SELECT COALESCE(c.slug, a.slug) as target_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
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
        const canonRes = await db.execute({
            sql: `SELECT id, canonicalId FROM albums WHERE id = ?`,
            args: [canonId]
        });
        
        if (canonRes.rows.length === 0) {
            return { success: false, message: `Canonical album ID \`${canonId}\` not found in the database.` };
        }
        
        const resolvedCanonId = (canonRes.rows[0].canonicalId || canonRes.rows[0].id) as number;

        const targetRes = await db.execute({
            sql: `SELECT id, canonicalId FROM albums WHERE id = ?`,
            args:[targetId]
        });
        
        if (targetRes.rows.length === 0) {
            return { success: false, message: `Target album ID \`${targetId}\` not found in the database.` };
        }

        if (resolvedCanonId === targetId || resolvedCanonId === targetRes.rows[0].canonicalId) {
            return { success: false, message: "These IDs already resolve to the same canonical album." };
        }

        await db.execute({
            sql: `UPDATE albums SET canonicalId = ? WHERE id = ?`,
            args: [resolvedCanonId, targetId]
        });

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
        await ensureAlbumRankingsCache();

        const sql = `
            WITH EligibleTopAlbums AS (
                SELECT c.slug
                FROM album_ranking_cache c
                JOIN albums a ON c.slug = a.slug
                WHERE a.albumHighlight IS NULL
                ORDER BY c.rank ASC
                LIMIT ?
            )
            SELECT slug FROM EligibleTopAlbums ORDER BY RANDOM() LIMIT 1;
        `;
        const result = await db.execute({ sql, args: [topLimit] });
        
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