import { db } from '@/utils/db'; // Your Turso client from the previous step
import { DbUser } from '@/data/models/dbuser';

/**
 * Fetches the entire user profile from the database.
 * Use this if you need multiple fields (e.g., display name AND Last.fm name).
 */
export async function getUserByDiscordId(discordUserId: string): Promise<DbUser | null> {
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM users WHERE userDiscordId = ?',
            args: [discordUserId]
        });
        
        if (result.rows.length === 0) return null;
        
        // Cast the LibSQL row to our DbUser interface
        return result.rows[0] as unknown as DbUser;
    } catch (error) {
        console.error(`[DB Error] Fetching user ${discordUserId}:`, error);
        return null;
    }
}

/**
 * Specifically fetches only the user's Last.fm username.
 * A direct replacement for: await kv.get(discordUserId)
 */
export async function getUserLastFM(discordUserId: string): Promise<string | null> {
    try {
        const result = await db.execute({
            sql: 'SELECT userLastFMUserName FROM users WHERE userDiscordId = ?',
            args: [discordUserId]
        });
        
        if (result.rows.length === 0) return null;
        
        return (result.rows[0].userLastFMUserName as string | null) || null;
    } catch (error) {
        console.error(`[DB Error] Fetching Last.fm for ${discordUserId}:`, error);
        return null;
    }
}

/**
 * Specifically fetches only the user's custom Display Name.
 */
export async function getUserDisplayName(discordUserId: string): Promise<string | null> {
    try {
        const result = await db.execute({
            sql: 'SELECT userDisplayName FROM users WHERE userDiscordId = ?',
            args: [discordUserId]
        });
        
        if (result.rows.length === 0) return null;
        
        return (result.rows[0].userDisplayName as string) || null;
    } catch (error) {
        console.error(`[DB Error] Fetching Display Name for ${discordUserId}:`, error);
        return null;
    }
}

//#region Profile Display

/**
 * Gets the distribution of scores (0-10) for a specific user.
 */
export async function getUserRatingDistribution(userId: string) {
    const result = await db.execute({
        sql: `
            SELECT score, COUNT(*) as count
            FROM ratings
            WHERE userId = ?
            GROUP BY score
            ORDER BY score DESC
        `,
        args: [userId]
    });
    return result.rows as unknown as Array<{ score: number, count: number }>;
}

/**
 * Gets the most recent ratings for a specific user.
 */
export async function getUserRecentRatings(userId: string, limit: number = 9) {
    const result = await db.execute({
        sql: `
            SELECT a.name as albumName, a.artistName, r.score, r.updatedAt
            FROM ratings r
            JOIN albums a ON r.albumId = a.slug
            WHERE r.userId = ?
            ORDER BY r.updatedAt DESC
            LIMIT ?
        `,
        args: [userId, limit]
    });
    return result.rows as unknown as Array<{ albumName: string, artistName: string, score: number, updatedAt: string }>;
}

//#endregion

