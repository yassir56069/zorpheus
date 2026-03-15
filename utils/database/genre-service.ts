// utils/database/genre-service.ts
import { db } from '@/utils/db';

export const VALID_GENRES =[
    "folk", "regional", "emo", "country", "blues", "funk", "soul", "jazz", "classical",
    "hip hop", "electronic", "rock", "pop", "vaporwave", "j-pop", "neo-psychedelia",
    "slowcore", "reggae", "punk", "post-punk", "progressive rock", "art rock", "shoegaze",
    "post-rock", "alternative rock", "indie rock", "metal", "experimental", "singer-songwriter", "ambient", "drone", "alternative country"
];

//#region Get Genres

/**
 * Fetches all genres associated with an album, intelligently merging 
 * genres from the target slug and any of its canonical/alias siblings.
 */
export async function getMergedAlbumGenres(slug: string): Promise<string[]> {
    const sql = `
        WITH TargetAlbum AS (
            SELECT COALESCE(c.slug, a.slug) as target_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
            -- Support truncated slugs by falling back to a LIKE wildcard
            WHERE a.slug = ? OR (LENGTH(?) >= 95 AND a.slug LIKE ?)
            LIMIT 1
        ),
        CanonicalAlbums AS (
            SELECT a.slug as original_slug, COALESCE(c.slug, a.slug) as canonical_slug
            FROM albums a
            LEFT JOIN albums c ON a.canonicalId = c.id
        )
        SELECT DISTINCT g.genreName
        FROM album_genres ag
        JOIN CanonicalAlbums ca ON ag.albumId = ca.original_slug
        JOIN TargetAlbum t ON ca.canonical_slug = t.target_slug
        JOIN genres g ON ag.genreId = g.genreId
        ORDER BY g.genreName ASC;
    `;

    try {
        const result = await db.execute({ sql, args:[slug, slug, slug + '%'] });
        return result.rows.map(row => row.genreName as string);
    } catch (error) {
        console.error(`[DB Error] Fetching genres for album ${slug}:`, error);
        return[];
    }
}

//#endregion

//#region  Add Genres

/**
 * Manually links a genre to an album based on an album's integer ID.
 */
export async function addManualAlbumGenre(albumId: number, genreName: string, userId: string) {
    const normalizedGenre = genreName.toLowerCase();
    
    if (!VALID_GENRES.includes(normalizedGenre)) {
        throw new Error("Invalid genre");
    }

    try {
        const albumRes = await db.execute({
            sql: `SELECT slug FROM albums WHERE id = ?`,
            args: [albumId]
        });

        if (albumRes.rows.length === 0) return false;
        
        // Use the slug because album_genres expects the slug format under albumId
        const albumSlug = albumRes.rows[0].slug as string;

        const genreRes = await db.execute({
            sql: `SELECT genreId FROM genres WHERE genreName = ?`,
            args: [normalizedGenre]
        });

        let genreId: number;

        if (genreRes.rows.length === 0) {
            const insertRes = await db.execute({
                sql: `INSERT INTO genres (genreName, source) VALUES (?, 0) RETURNING genreId`,
                args: [normalizedGenre]
            });
            genreId = insertRes.rows[0].genreId as number;
        } else {
            genreId = genreRes.rows[0].genreId as number;
        }

        // Link to album (source 0 = manual user submitted)
        await db.execute({
            sql: `
                INSERT INTO album_genres (albumId, genreId, weight, fromUser, source)
                VALUES (?, ?, 1, ?, 0)
                ON CONFLICT(albumId, genreId) DO NOTHING
            `,
            args: [albumSlug, genreId, userId]
        });
        
        return true;
    } catch (error) {
        console.error(`[DB Error] Failed to link manual genre ${genreName} to album ID ${albumId}:`, error);
        return false;
    }
}

//#endregion

/**
 * Maps messy Last.fm tags to our strict 29-genre taxonomy.
 * Returns null if the tag doesn't fit into our taxonomy.
 */
export function mapLastFmTagToGenre(tag: string): string | null {
    const t = tag.toLowerCase().trim();

    // 1. Check strict rules & aliases
    const EXACT_MAPPINGS: Record<string, string> = {
        "folk rock": "folk",
        "midwestern emo": "emo",
        "midwest emo": "emo",
        "trap": "hip hop",
        "synth pop": "neo-psychedelia",
        "synthpop": "neo-psychedelia",
        "post-hardcore": "post-punk",
        "post hardcore": "post-punk",
        "hip-hop": "hip hop",
        "hiphop": "hip hop",
        "rap": "hip hop",
        "jpop": "j-pop",
        "j pop": "j-pop",
        "prog rock": "progressive rock",
        "alt rock": "alternative rock",
        "rnb": "soul",
        "r&b": "soul",
        "edm": "electronic",
        "idm": "electronic",
        "house": "electronic",
        "techno": "electronic",
        "indie": "indie rock",
        "alt country": "alternative country",
    };

    if (EXACT_MAPPINGS[t]) return EXACT_MAPPINGS[t];
    if (VALID_GENRES.includes(t)) return t;

    // 2. Substring fallbacks (Order is extremely important here!)
    
    // Sub-rocks & Punks
    if (t.includes("post-rock")) return "post-rock";
    if (t.includes("post-punk")) return "post-punk";
    if (t.includes("progressive rock") || t.includes("prog")) return "progressive rock";
    if (t.includes("art rock")) return "art rock";
    if (t.includes("indie rock")) return "indie rock";
    if (t.includes("alternative rock") || t.includes("alt-rock") || t.includes("alternative")) return "alternative rock";
    if (t.includes("alternative country") || t.includes("alt-country")) return "alternative country";
    if (t.includes("shoegaze")) return "shoegaze";
    if (t.includes("punk")) return "punk"; 
    
    // Broad catch-alls
    if (t.includes("metal")) return "metal"; // Catches "sludge metal", "black metal"
    if (t.includes("folk")) return "folk";
    if (t.includes("emo")) return "emo";
    if (t.includes("jazz")) return "jazz";
    if (t.includes("classical")) return "classical";
    if (t.includes("hip hop") || t.includes("rap")) return "hip hop";
    if (t.includes("electronic") || t.includes("electro")) return "electronic";
    
    if (t.includes("pop")) {
        if (t.includes("j-pop") || t.includes("jpop")) return "j-pop";
        if (t.includes("synth") || t.includes("dream")) return "neo-psychedelia"; // user rule for synth pop
        return "pop";
    }
    
    if (t.includes("rock")) return "rock"; // Catch-all for "glam-rock", "hard rock", etc.
    
    if (t.includes("ambient")) return "ambient";
    if (t.includes("drone")) return "drone";
    if (t.includes("country")) return "country";
    if (t.includes("blues")) return "blues";
    if (t.includes("soul")) return "soul";
    if (t.includes("funk")) return "funk";
    if (t.includes("reggae")) return "reggae";
    if (t.includes("vaporwave")) return "vaporwave";
    if (t.includes("slowcore")) return "slowcore";
    if (t.includes("experimental")) return "experimental";
    if (t.includes("singer-songwriter")) return "singer-songwriter";

    // Tag is entirely irrelevant to our database
    return null;
}

/**
 * Takes Last.fm tags, maps them, and associates them with an album in the DB.
 */
export async function linkAlbumGenres(albumSlug: string, lastfmTags: string[], userId: string) {
    // 1. Filter and map
    const mappedGenres = new Set<string>();
    for (const tag of lastfmTags) {
        const mapped = mapLastFmTagToGenre(tag);
        if (mapped) mappedGenres.add(mapped);
    }

    if (mappedGenres.size === 0) return;

    // 2. Process valid genres into the database
    for (const genreName of mappedGenres) {
        try {
            // Get or create genre (source 0 = user submitted as requested)
            const genreRes = await db.execute({
                sql: `SELECT genreId FROM genres WHERE genreName = ?`,
                args: [genreName]
            });

            let genreId: number;

            if (genreRes.rows.length === 0) {
                const insertRes = await db.execute({
                    sql: `INSERT INTO genres (genreName, source) VALUES (?, 0) RETURNING genreId`,
                    args: [genreName]
                });
                genreId = insertRes.rows[0].genreId as number;
            } else {
                genreId = genreRes.rows[0].genreId as number;
            }

            // Link to album (source 1 = Last.fm, weight 1 = primary)
            // DO NOTHING on conflict prevents duplicates per album
            await db.execute({
                sql: `
                    INSERT INTO album_genres (albumId, genreId, weight, fromUser, source)
                    VALUES (?, ?, 1, ?, 1)
                    ON CONFLICT(albumId, genreId) DO NOTHING
                `,
                args:[albumSlug, genreId, userId]
            });
        } catch (error) {
            console.error(`[DB Error] Failed to link genre ${genreName} to album ${albumSlug}:`, error);
        }
    }



}

