import { db } from '@/utils/db';
import crypto from 'crypto';

export interface MusicPageOptions {
    genres?: string[];
    artists?: string[];
    titles?: string[];
    userId?: string;
    minRating?: number;
    sort?: 'highest' | 'popular' | 'unrated' | 'recent';
    actingUserId: string;
}

let tablesEnsured = false;
export async function ensureMusicPageTables() {
    if (tablesEnsured) return;
    await db.execute({ sql: `CREATE TABLE IF NOT EXISTS music_page_sessions (session_id TEXT PRIMARY KEY, params_json TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, args: [] });
    await db.execute({ sql: `CREATE TABLE IF NOT EXISTS music_page_images (cache_key TEXT PRIMARY KEY, image_blob BLOB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`, args: [] });
    tablesEnsured = true;
}

export async function saveMusicPageSession(params: MusicPageOptions): Promise<string> {
    await ensureMusicPageTables();
    const paramsJson = JSON.stringify(params);
    const sessionId = crypto.createHash('md5').update(paramsJson).digest('hex'); 
    await db.execute({
        sql: `INSERT OR IGNORE INTO music_page_sessions (session_id, params_json) VALUES (?, ?)`,
        args: [sessionId, paramsJson]
    });
    return sessionId;
}

export async function getMusicPageSession(sessionId: string): Promise<MusicPageOptions | null> {
    await ensureMusicPageTables();
    const res = await db.execute({
        sql: `SELECT params_json FROM music_page_sessions WHERE session_id = ?`,
        args: [sessionId]
    });
    if (res.rows.length > 0) {
        return JSON.parse(res.rows[0].params_json as string);
    }
    return null;
}

export async function getMusicPageImage(cacheKey: string): Promise<Buffer | null> {
    await ensureMusicPageTables();
    const res = await db.execute({
        sql: `SELECT image_blob FROM music_page_images WHERE cache_key = ?`,
        args: [cacheKey]
    });
    if (res.rows.length > 0) {
        return Buffer.from(res.rows[0].image_blob as ArrayBuffer);
    }
    return null;
}

export async function saveMusicPageImage(cacheKey: string, imageBlob: Buffer) {
    await ensureMusicPageTables();
    
    // Manage maximum of 10 concurrent images cache queue system
    const countRes = await db.execute({ sql: `SELECT COUNT(*) as c FROM music_page_images`, args: [] });
    const count = countRes.rows[0].c as number;
    if (count >= 10) {
        await db.execute({
            sql: `DELETE FROM music_page_images WHERE cache_key = (SELECT cache_key FROM music_page_images ORDER BY created_at ASC LIMIT 1)`,
            args: []
        });
    }

    await db.execute({
        sql: `INSERT OR REPLACE INTO music_page_images (cache_key, image_blob) VALUES (?, ?)`,
        args: [cacheKey, imageBlob]
    });
}

export async function getMusicPageAlbums(options: MusicPageOptions, page: number, limit: number) {
    const { genres, artists, titles, userId, minRating, sort = 'highest', actingUserId } = options;
    const offset = (page - 1) * limit;

    let globalAvg = 7.0; 
    try {
        const avgRes = await db.execute({ sql: `SELECT value FROM system_stats WHERE key = 'global_rating_avg'`, args: [] });
        if (avgRes.rows.length > 0) globalAvg = Number(avgRes.rows[0].value);
    } catch(e) {}
    
    const minRatings = 3;

    const args: any[] = [];
    const ctes: string[] = [];

    // Filter early as possible to keep 'CombinedRatings' heavily optimized
    let canonicalConditions = '';
    if (artists && artists.length > 0) {
        canonicalConditions += ` AND (${artists.map(() => '(a.artistName LIKE ? OR c.artistName LIKE ?)').join(' OR ')})`;
        artists.forEach(a => args.push(`%${a.trim()}%`, `%${a.trim()}%`));
    }
    if (titles && titles.length > 0) {
        canonicalConditions += ` AND (${titles.map(() => '(a.name LIKE ? OR c.name LIKE ?)').join(' OR ')})`;
        titles.forEach(t => args.push(`%${t.trim()}%`, `%${t.trim()}%`));
    }

    ctes.push(`
        CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE 1=1 ${canonicalConditions}
        )
    `);

    let unratedJoin = '';
    if (sort === 'unrated') {
        ctes.push(`
            UserRatedAlbums AS (
                SELECT DISTINCT COALESCE(c.slug, a.slug) as canonical_slug
                FROM ratings r
                JOIN albums a ON r.albumId = a.slug
                LEFT JOIN albums c ON a.canonicalId = c.id
                WHERE r.userId = ?
            )
        `);
        args.push(actingUserId);
        unratedJoin = `LEFT JOIN UserRatedAlbums ura ON s.albumId = ura.canonical_slug`;
    }

    let genreJoin = '';
    if (genres && genres.length > 0) {
        ctes.push(`
            ValidGenreAlbums AS (
                SELECT DISTINCT COALESCE(c.slug, a.slug) as canonical_slug
                FROM albums a
                LEFT JOIN albums c ON a.canonicalId = c.id
                JOIN album_genres ag ON ag.albumId = a.slug
                JOIN genres g ON ag.genreId = g.genreId
                WHERE g.genreName IN (${genres.map(() => '?').join(', ')})
            )
        `);
        args.push(...genres.map(g => g.trim().toLowerCase()));
        genreJoin = `JOIN ValidGenreAlbums vga ON ca.canonical_slug = vga.canonical_slug`;
    }

    ctes.push(`
        CombinedRatings AS MATERIALIZED (
            SELECT ca.canonical_slug as albumId, r.userId, MAX(r.score) as score, MAX(r.updatedAt) as lastRated
            FROM ratings r
            JOIN CanonicalAlbums ca ON r.albumId = ca.original_slug
            ${genreJoin}
            WHERE r.score > 0
            GROUP BY ca.canonical_slug, r.userId
        )
    `);

    ctes.push(`
        AlbumSums AS (
            SELECT 
                c.albumId, 
                COUNT(c.userId) as ratingCount,
                (CAST(SUM(c.score) AS FLOAT) / COUNT(c.userId)) as avgScore,
                (SUM(c.score) + (? * ?)) / (COUNT(c.userId) + ?) as weightedScore,
                MAX(c.lastRated) as mostRecentRating
            FROM CombinedRatings c
            GROUP BY c.albumId
        )
    `);
    args.push(minRatings, globalAvg, minRatings);

    let sql = `WITH ${ctes.join(', ')}
        SELECT 
            a.name, a.artistName, a.slug, a.coverArtUrl,
            s.ratingCount, s.avgScore, s.weightedScore, s.mostRecentRating
        FROM AlbumSums s
        JOIN albums a ON s.albumId = a.slug
        ${unratedJoin}
    `;

    let filterUserJoin = '';
    if (userId) {
        filterUserJoin = `
        JOIN (
            SELECT DISTINCT COALESCE(c.slug, a.slug) as canonical_slug
            FROM ratings r
            JOIN albums a ON r.albumId = a.slug
            LEFT JOIN albums c ON a.canonicalId = c.id
            WHERE r.userId = ?
        ) fura ON s.albumId = fura.canonical_slug
        `;
        args.push(userId);
    }
    sql += filterUserJoin;

    let conditions = ` WHERE 1=1 `;
    if (sort === 'unrated') conditions += ` AND ura.canonical_slug IS NULL`;
    if (minRating) {
        conditions += ` AND s.avgScore >= ?`;
        args.push(minRating * 2);
    }
    sql += conditions;

    let orderBy = 's.weightedScore DESC, s.ratingCount DESC';
    if (sort === 'popular') orderBy = 's.ratingCount DESC, s.weightedScore DESC';
    if (sort === 'recent') orderBy = 's.mostRecentRating DESC, s.weightedScore DESC';
    
    sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    args.push(limit, offset);

    const result = await db.execute({ sql, args });
    return result.rows as any[];
}