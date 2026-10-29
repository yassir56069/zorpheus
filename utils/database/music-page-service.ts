import { db } from '@/utils/db';
import { ensureAlbumRankingsCache } from './album-service';
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

    // Optional: ping your cache to make sure it is up to date
    await ensureAlbumRankingsCache(); 

    const args: any[] = [];
    
    let sql = `
        SELECT 
            a.name, a.artistName, a.slug, a.coverArtUrl,
            arc.ratingCount, arc.avgScore, arc.weightedScore, arc.mostRecentRating
        FROM album_ranking_cache arc
        JOIN albums a ON arc.slug = a.slug
    `;

    if (genres && genres.length > 0) {
        sql += `
            JOIN album_genres ag ON ag.albumId = a.slug
            JOIN genres g ON ag.genreId = g.genreId AND g.genreName IN (${genres.map(() => '?').join(', ')})
        `;
        args.push(...genres.map(g => g.trim().toLowerCase()));
    }

    let conditions = ` WHERE 1=1 `;

    if (artists && artists.length > 0) {
        conditions += ` AND EXISTS (
            SELECT 1 FROM albums orig 
            WHERE (orig.slug = a.slug OR orig.canonicalId = a.id) AND (${artists.map(() => 'orig.artistName LIKE ?').join(' OR ')})
        )`;
        artists.forEach(a => args.push(`%${a.trim()}%`));
    }

    if (titles && titles.length > 0) {
        conditions += ` AND EXISTS (
            SELECT 1 FROM albums orig 
            WHERE (orig.slug = a.slug OR orig.canonicalId = a.id) AND (${titles.map(() => 'orig.name LIKE ?').join(' OR ')})
        )`;
        titles.forEach(t => args.push(`%${t.trim()}%`));
    }

    if (sort === 'unrated') {
        conditions += ` AND NOT EXISTS (
            SELECT 1 FROM ratings r LEFT JOIN albums c ON r.albumId = c.slug 
            WHERE r.userId = ? AND (r.albumId = a.slug OR c.canonicalId = a.id)
        )`;
        args.push(actingUserId);
    }

    if (userId) {
        conditions += ` AND EXISTS (
            SELECT 1 FROM ratings r LEFT JOIN albums c ON r.albumId = c.slug 
            WHERE r.userId = ? AND (r.albumId = a.slug OR c.canonicalId = a.id)
        )`;
        args.push(userId);
    }

    if (minRating) {
        conditions += ` AND arc.avgScore >= ?`;
        args.push(minRating * 2);
    }

    sql += conditions + ` ORDER BY `;
    
    if (sort === 'popular') sql += 'arc.ratingCount DESC, arc.weightedScore DESC';
    else if (sort === 'recent') sql += 'arc.mostRecentRating DESC, arc.weightedScore DESC';
    else sql += 'arc.weightedScore DESC, arc.ratingCount DESC';
    
    sql += ` LIMIT ? OFFSET ?`;
    args.push(limit, offset);

    const result = await db.execute({ sql, args });
    return result.rows as any[];
}
