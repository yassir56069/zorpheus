import crypto from 'crypto';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const LASTFM_API_SECRET = process.env.LASTFM_API_SECRET!;

/** Build the MD5 api_sig required by Last.fm signed calls */
export function buildApiSig(params: Record<string, string>): string {
    // Sort keys alphabetically, concatenate key+value, append secret, MD5
    const sorted = Object.keys(params).sort();
    const base = sorted.map(k => `${k}${params[k]}`).join('') + LASTFM_API_SECRET;
    return crypto.createHash('md5').update(base, 'utf8').digest('hex');
}

/** Exchange a token for a session key */
export async function getSessionKey(token: string): Promise<string> {
    const params: Record<string, string> = {
        method: 'auth.getSession',
        api_key: LASTFM_API_KEY,
        token,
    };
    const api_sig = buildApiSig(params);

    const url = new URL('https://ws.audioscrobbler.com/2.0/');
    url.searchParams.set('method', 'auth.getSession');
    url.searchParams.set('api_key', LASTFM_API_KEY);
    url.searchParams.set('token', token);
    url.searchParams.set('api_sig', api_sig);
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString());
    const data = await res.json();

    if (data.error) throw new Error(`Last.fm auth error: ${data.message}`);
    return data.session.key as string;
}

/** Love a track using a stored session key */
export async function loveTrack(artist: string, track: string, sessionKey: string): Promise<void> {
    const params: Record<string, string> = {
        method: 'track.love',
        api_key: LASTFM_API_KEY,
        artist,
        track,
        sk: sessionKey,
    };
    const api_sig = buildApiSig(params);

    const body = new URLSearchParams({ ...params, api_sig, format: 'json' });
    const res = await fetch('https://ws.audioscrobbler.com/2.0/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Last.fm love error: ${data.message}`);
}