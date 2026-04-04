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

export async function getAllLastFMUsers(): Promise<string[]> {
    try {
        const result = await db.execute({
            sql: 'SELECT userLastFMUserName FROM users WHERE userLastFMUserName IS NOT NULL',
            args: []
        });
        
        return result.rows.map(row => row.userLastFMUserName as string);
    } catch (error) {
        console.error(`[DB Error] Fetching all Last.fm users:`, error);
        return [];
    }
}

//#region Last.fm Love
export async function getUserLastFMSessionKey(discordUserId: string): Promise<string | null> {
    try {
        const result = await db.execute({
            sql: 'SELECT lastfmSessionKey FROM users WHERE userDiscordId = ?',
            args: [discordUserId]
        });
        if (result.rows.length === 0) return null;
        return (result.rows[0].lastfmSessionKey as string | null) || null;
    } catch (error) {
        console.error(`[DB Error] Fetching Last.fm session key for ${discordUserId}:`, error);
        return null;
    }
}

export async function saveLastFMSessionKey(discordUserId: string, sessionKey: string): Promise<void> {
    try {
        await db.execute({
            sql: 'UPDATE users SET lastfmSessionKey = ?, modifiedAt = CURRENT_TIMESTAMP WHERE userDiscordId = ?',
            args: [sessionKey, discordUserId]
        });
    } catch (error) {
        console.error(`[DB Error] Saving Last.fm session key for ${discordUserId}:`, error);
    }
}
//#endregion