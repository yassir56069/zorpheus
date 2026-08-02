import { db } from '@/utils/db';
import { MIN_RATINGS_TO_RANK } from './album-service';

// An album is eligible to be featured if it has exactly MIN_RATINGS_TO_RANK - 1 ratings
export const FEATURE_ELIGIBLE_MAX_RATINGS = MIN_RATINGS_TO_RANK - 2; // 3
export const FEATURE_DURATION_DAYS = 7;

export interface FeatureQueueEntry {
    id: number;
    userId: string;
    albumSlug: string;
    startDate: string; // ISO date string
}

export interface FeaturedAlbumInfo {
    albumSlug: string;
    startDate: string;
    endDate: string;
    featureScore: number;
    ratingCount: number;
}

export interface FeaturePoints {
    userId: string;
    points: number;
}


/**
 * Manually adjusts the feature points for a user.
 * Accepts positive or negative amounts.
 */
export async function adjustUserFeaturePoints(userId: string, amount: number): Promise<number> {
    // Upsert manual adjustment using a system placeholder slug
    await db.execute({
        sql: `
            INSERT INTO feature_points (userId, albumSlug, points, awardedAt)
            VALUES (?, 'system-adjustment', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(userId, albumSlug) DO UPDATE SET 
                points = points + excluded.points
        `,
        args: [userId, amount]
    });

    // Fetch and return the updated total
    const pointsRes = await db.execute({
        sql: `SELECT COALESCE(SUM(points), 0) as total FROM feature_points WHERE userId = ?`,
        args: [userId]
    });
    return (pointsRes.rows[0]?.total as number) ?? 0;
}

/**
 * Returns the feature information for a specific album slug.
 */
export async function getAlbumFeatureInfo(albumSlug: string): Promise<FeaturedAlbumInfo | null> {
    const res = await db.execute({
        sql: `
            SELECT albumSlug, score as featureScore, ratingCount, startDate, endDate
            FROM featured_album_scores
            WHERE albumSlug = ?
        `,
        args: [albumSlug]
    });

    if (res.rows.length === 0) return null;
    return res.rows[0] as unknown as FeaturedAlbumInfo;
}

export async function getAlbumFeaturedState(albumSlug: string): Promise<number> {
    const res = await db.execute({
        sql: `SELECT isFeatured FROM albums WHERE slug = ?`,
        args: [albumSlug]
    });

    if (res.rows.length === 0) return 0;
    return (res.rows[0].isFeatured as number) ?? 0;
}


// ---------------------------------------------------------------------------
// Schema helpers (run once at boot or via migration)
// ---------------------------------------------------------------------------

/**
 * Creates the feature_queue table and adds isFeatured column to albums if missing.
 * Safe to call multiple times (uses IF NOT EXISTS / IGNORE).
 */
export async function ensureFeatureSchema(): Promise<void> {
    // feature_queue table
    await db.execute({
        sql: `
            CREATE TABLE IF NOT EXISTS feature_queue (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                userId      TEXT    NOT NULL,
                albumSlug   TEXT    NOT NULL,
                startDate   TEXT    NOT NULL,
                createdAt   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(albumSlug)
            )
        `,
        args: []
    });

    // isFeatured column on albums (1 = currently featured, 2 = has been featured before)
    // We use a try/catch because ALTER TABLE fails if the column already exists in SQLite
    try {
        await db.execute({
            sql: `ALTER TABLE albums ADD COLUMN isFeatured INTEGER NOT NULL DEFAULT 0`,
            args: []
        });
    } catch {
        // Column already exists — ignore
    }

    // feature_points table — tracks per-user points earned from featured ratings
    await db.execute({
        sql: `
            CREATE TABLE IF NOT EXISTS feature_points (
                userId      TEXT    NOT NULL,
                albumSlug   TEXT    NOT NULL,
                points      INTEGER NOT NULL DEFAULT 0,
                awardedAt   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (userId, albumSlug)
            )
        `,
        args: []
    });

    // featured_album_scores — running score tally for each featured album
    await db.execute({
        sql: `
            CREATE TABLE IF NOT EXISTS featured_album_scores (
                albumSlug   TEXT    PRIMARY KEY,
                score       INTEGER NOT NULL DEFAULT 0,
                ratingCount INTEGER NOT NULL DEFAULT 0,
                startDate   TEXT    NOT NULL,
                endDate     TEXT    NOT NULL
            )
        `,
        args: []
    });
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Checks whether an album is eligible to be added to the feature queue.
 * Eligible = exactly (MIN_RATINGS_TO_RANK - 1) ratings AND never been featured.
 */
export async function isAlbumFeatureEligible(albumSlug: string): Promise<{
    eligible: boolean;
    reason?: string;
    ratingCount?: number;
}> {
    const res = await db.execute({
        sql: `
            SELECT 
                a.isFeatured,
                COUNT(DISTINCT r.userId) as ratingCount
            FROM albums a
            LEFT JOIN ratings r ON r.albumId = a.slug AND r.score > 0
            WHERE a.slug = ?
            GROUP BY a.id
        `,
        args: [albumSlug]
    });

    if (res.rows.length === 0) {
        return { eligible: false, reason: 'Album not found.' };
    }

    const row = res.rows[0];
    const isFeatured = row.isFeatured as number;
    const ratingCount = row.ratingCount as number;

    if (isFeatured > 0) {
        return { eligible: false, reason: 'This album has already been featured or is currently featured.', ratingCount };
    }

    if (ratingCount >= MIN_RATINGS_TO_RANK) {
        return { eligible: false, reason: `This album already has enough ratings to rank (${ratingCount}/${MIN_RATINGS_TO_RANK}).`, ratingCount };
    }

    if (ratingCount === 0) {
        return { eligible: false, reason: 'This album has no ratings yet.', ratingCount };
    }

    // Check it's not already in the queue
    const queued = await db.execute({
        sql: `SELECT id FROM feature_queue WHERE albumSlug = ? LIMIT 1`,
        args: [albumSlug]
    });
    if (queued.rows.length > 0) {
        return { eligible: false, reason: 'This album is already in the feature queue.' };
    }

    return { eligible: true, ratingCount };
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

/**
 * Computes the ISO date string for when a newly enqueued album would start.
 * The first album starts on 2026-05-18 (Monday). Each subsequent slot is +7 days.
 */
async function computeNextStartDate(): Promise<string> {
    const EPOCH = new Date('2026-05-18T00:00:00.000Z');

    const res = await db.execute({
        sql: `SELECT startDate FROM feature_queue ORDER BY startDate DESC LIMIT 1`,
        args: []
    });

    if (res.rows.length === 0) {
        // Also check featured_album_scores for the last known end date
        const lastFeatured = await db.execute({
            sql: `SELECT endDate FROM featured_album_scores ORDER BY endDate DESC LIMIT 1`,
            args: []
        });

        if (lastFeatured.rows.length > 0) {
            const lastEnd = new Date(lastFeatured.rows[0].endDate as string);
            // Next album starts the day after the last one ends
            lastEnd.setUTCDate(lastEnd.getUTCDate() + 1);
            return lastEnd.toISOString().split('T')[0];
        }

        return EPOCH.toISOString().split('T')[0];
    }

    // Last entry in queue: add 7 days
    const lastStart = new Date((res.rows[0].startDate as string) + 'T00:00:00.000Z');
    lastStart.setUTCDate(lastStart.getUTCDate() + FEATURE_DURATION_DAYS);
    return lastStart.toISOString().split('T')[0];
}

/**
 * Adds an album to the feature queue on behalf of a user.
 * Returns the computed startDate on success.
 */
export async function enqueueAlbumForFeature(
    userId: string,
    albumSlug: string
): Promise<{ success: boolean; startDate?: string; reason?: string }> {
    const eligibility = await isAlbumFeatureEligible(albumSlug);
    if (!eligibility.eligible) {
        return { success: false, reason: eligibility.reason };
    }

    const startDate = await computeNextStartDate();

    try {
        await db.execute({
            sql: `
                INSERT INTO feature_queue (userId, albumSlug, startDate, createdAt)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `,
            args: [userId, albumSlug, startDate]
        });
        return { success: true, startDate };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('UNIQUE')) {
            return { success: false, reason: 'This album is already in the feature queue.' };
        }
        console.error('[FEATURE] enqueueAlbumForFeature error:', e);
        return { success: false, reason: 'A database error occurred.' };
    }
}

/**
 * Returns all entries currently in the feature queue, ordered by startDate.
 */
export async function getFeatureQueue(): Promise<FeatureQueueEntry[]> {
    const res = await db.execute({
        sql: `
            SELECT fq.id, fq.userId, fq.albumSlug, fq.startDate
            FROM feature_queue fq
            ORDER BY fq.startDate ASC
        `,
        args: []
    });
    return res.rows as unknown as FeatureQueueEntry[];
}

// ---------------------------------------------------------------------------
// Activation — called by a scheduled job (e.g. daily cron)
// ---------------------------------------------------------------------------

/**
 * Checks if the next album in the queue should go live today, and if so,
 * activates it: marks isFeatured = 1, writes a featured_album_scores row,
 * and removes the entry from feature_queue.
 *
 * Also expires any currently active featured album whose week has ended
 * (sets isFeatured = 2).
 *
 * Returns the slug of the newly activated album, or null if nothing changed.
 */
export async function tickFeaturedAlbum(): Promise<{ activated: string | null; expired: string | null }> {
    const todayStr = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"

    let expired: string | null = null;
    let activated: string | null = null;

    // 1. Expire any album whose endDate has passed
    const expireRes = await db.execute({
        sql: `
            SELECT albumSlug FROM featured_album_scores
            WHERE endDate < ?
        `,
        args: [todayStr]
    });

    for (const row of expireRes.rows) {
        const slug = row.albumSlug as string;
        await db.execute({
            sql: `UPDATE albums SET isFeatured = 2 WHERE slug = ?`,
            args: [slug]
        });
        expired = slug;
    }

    // 2. Check queue for an album whose startDate is today or earlier
    const nextRes = await db.execute({
        sql: `
            SELECT id, userId, albumSlug, startDate
            FROM feature_queue
            WHERE startDate <= ?
            ORDER BY startDate ASC
            LIMIT 1
        `,
        args: [todayStr]
    });

    if (nextRes.rows.length === 0) return { activated, expired };

    const next = nextRes.rows[0];
    const slug = next.albumSlug as string;
    const startDate = next.startDate as string;
    const endDate = (() => {
        const d = new Date(startDate + 'T00:00:00.000Z');
        d.setUTCDate(d.getUTCDate() + FEATURE_DURATION_DAYS - 1);
        return d.toISOString().split('T')[0];
    })();

    // Mark album as currently featured
    await db.execute({
        sql: `UPDATE albums SET isFeatured = 1 WHERE slug = ?`,
        args: [slug]
    });

    // Create score tracking row
    await db.execute({
        sql: `
            INSERT INTO featured_album_scores (albumSlug, score, ratingCount, startDate, endDate)
            VALUES (?, 0, 0, ?, ?)
            ON CONFLICT(albumSlug) DO NOTHING
        `,
        args: [slug, startDate, endDate]
    });

    // Remove from queue
    await db.execute({
        sql: `DELETE FROM feature_queue WHERE id = ?`,
        args: [next.id]
    });

    activated = slug;
    return { activated, expired };
}

// ---------------------------------------------------------------------------
// Scoring — called whenever a user rates the currently featured album
// ---------------------------------------------------------------------------

/**
 * Awards feature points to a user and recalculates the album's feature score.
 * Call this after a rating is submitted for an album where isFeatured is 1 or 2.
 *
 * User earns 2 points if rated during the week (isFeatured = 1), and 1 point if after.
 * Score is recalculated to avoid summing inflation when scores are updated.
 */
export async function recordFeaturedRating(
    userId: string,
    albumSlug: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    score: number // Kept for backwards signature compatibility
): Promise<{ userPoints: number; albumScore: number }> {
    // Check album's featured state (1 = currently featured, 2 = previously featured)
    const albumRes = await db.execute({
        sql: `SELECT isFeatured FROM albums WHERE slug = ?`,
        args: [albumSlug]
    });

    if (albumRes.rows.length === 0) {
        return { userPoints: 0, albumScore: 0 };
    }

    const isFeatured = albumRes.rows[0].isFeatured as number;
    if (!isFeatured || isFeatured === 0) {
        // Never featured — no points awarded, no score tracked
        return { userPoints: 0, albumScore: 0 };
    }

    const pointsToAward = isFeatured === 1 ? 2 : 1;

    // Upsert user points 
    // CASE ensures that if a user already earned 2 points during the feature week, 
    // a later re-rate (where excluded points = 1) will not downgrade their score.
    await db.execute({
        sql: `
            INSERT INTO feature_points (userId, albumSlug, points, awardedAt)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(userId, albumSlug) DO UPDATE SET 
                points = CASE WHEN excluded.points > feature_points.points THEN excluded.points ELSE feature_points.points END
        `,
        args: [userId, albumSlug, pointsToAward]
    });

    // Recalculate Album Score exactly as the canonical album-service computes it.
    // This solves the bug where re-rates were adding points continuously instead of updating.
    const recalcRes = await db.execute({
        sql: `
            WITH CanonicalAlbums AS (
                SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
                FROM albums a
                LEFT JOIN albums c ON a.canonicalId = c.id
            ),
            TargetCanonical AS (
                SELECT canonical_slug 
                FROM CanonicalAlbums 
                WHERE original_slug = ?
                LIMIT 1
            ),
            CombinedRatings AS (
                SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score
                FROM ratings r
                JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
                JOIN TargetCanonical tc ON ca.canonical_slug = tc.canonical_slug
                WHERE r.score > 0
                GROUP BY r.userId
            )
            SELECT 
                COALESCE(SUM(score), 0) as totalScore, 
                COUNT(userId) as ratingCount
            FROM CombinedRatings
        `,
        args: [albumSlug]
    });

    const totalScore = (recalcRes.rows[0]?.totalScore as number) ?? 0;
    const ratingCount = (recalcRes.rows[0]?.ratingCount as number) ?? 0;

    // Persist the recalculated absolute totals back into the featured_album_scores table
    await db.execute({
        sql: `
            UPDATE featured_album_scores
            SET score = ?,
                ratingCount = ?
            WHERE albumSlug = ?
        `,
        args: [totalScore, ratingCount, albumSlug]
    });

    // Fetch updated totals for the response
    const pointsRes = await db.execute({
        sql: `SELECT COALESCE(SUM(points), 0) as total FROM feature_points WHERE userId = ?`,
        args: [userId]
    });
    const userPoints = (pointsRes.rows[0]?.total as number) ?? 0;

    return { userPoints, albumScore: totalScore };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the currently active featured album, or null if none is live.
 */
export async function getCurrentFeaturedAlbum(): Promise<FeaturedAlbumInfo | null> {
    const res = await db.execute({
        sql: `
            SELECT albumSlug, score as featureScore, ratingCount, startDate, endDate
            FROM featured_album_scores
            WHERE startDate <= date('now') AND endDate >= date('now')
            LIMIT 1
        `,
        args: []
    });

    if (res.rows.length === 0) return null;
    return res.rows[0] as unknown as FeaturedAlbumInfo;
}

/**
 * Returns total feature points for a given user.
 */
export async function getUserFeaturePoints(userId: string): Promise<number> {
    const res = await db.execute({
        sql: `SELECT COALESCE(SUM(points), 0) as total FROM feature_points WHERE userId = ?`,
        args: [userId]
    });
    return (res.rows[0]?.total as number) ?? 0;
}

/**
 * Returns the feature leaderboard (top users by points).
 */
export async function getFeatureLeaderboard(limit = 10): Promise<FeaturePoints[]> {
    const res = await db.execute({
        sql: `
            SELECT userId, SUM(points) as points
            FROM feature_points
            GROUP BY userId
            ORDER BY points DESC
            LIMIT ?
        `,
        args: [limit]
    });
    return res.rows as unknown as FeaturePoints[];
}