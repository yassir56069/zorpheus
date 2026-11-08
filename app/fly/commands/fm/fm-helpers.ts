import { syncAlbumCover, generateSlug } from '@/utils/database/album-service';
import { linkAlbumGenres } from '@/utils/database/genre-service';
import { loveTrack } from '@/utils/lastfm-auth';
import { Vibrant } from 'node-vibrant/node';

export function cleanArtistName(artist: string): string {
    console.log(`[Artist Filter] Executing. Original artist: "${artist}"`);
    const topicPattern = /\s-\sTopic\s*-?$/i;

    if (topicPattern.test(artist)) {
        const cleanedArtist = artist.replace(topicPattern, '').trim();
        console.log(`[Artist Filter] Pattern matched. Cleaned artist to: "${cleanedArtist}"`);
        return cleanedArtist;
    } else {
        console.log(`[Artist Filter] Pattern did not match. No changes made.`);
        return artist;
    }
}

export async function isValidImageUrl(url: string | null | undefined, timeout = 2500): Promise<boolean> {
    if (!url) {
        return false;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        return response.ok;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            console.log(`Image URL timed out: ${url}`);
        } else {
            console.error(`Error fetching image URL head: ${url}`, error);
        }
        return false;
    }
}


export async function findCoverOnMusicBrainz(artist: string, album: string): Promise<string | null> {  
    const userAgent = process.env.MUSICBRAINZ_USER_AGENT;
    if (!userAgent) {
        console.log("MusicBrainz User-Agent not set, skipping this fallback.");
        return null;
    }
    try {
        const musicBrainzUrl = `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(album)}%20AND%20artist:${encodeURIComponent(artist)}&fmt=json`;
        const mbResponse = await fetch(musicBrainzUrl, { headers: { 'User-Agent': userAgent } });
        if (!mbResponse.ok) return null;
        
        const mbData = await mbResponse.json();
        const release = mbData.releases?.[0];
        const releaseId = release?.id;
        
        if (!releaseId) return null;
        
        const coverArtUrl = `https://coverartarchive.org/release/${releaseId}`;
        const caResponse = await fetch(coverArtUrl);
        if (!caResponse.ok) return null;
        
        const caData = await caResponse.json();
        const frontImage = caData.images?.find((img: { front: boolean; }) => img.front);
        
        if (frontImage?.image) {
            console.log("Successfully got album art from Cover Art Archive.");
            return frontImage.image;
        }
    } catch (error) {
        console.error("Error fetching from MusicBrainz/Cover Art Archive:", error);
    }
    return null;
}

export async function findCoverArt(artist: string, album: string): Promise<string | null> {
    try {
        const searchTerm = `${artist} ${album}`;
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=5`;
        const response = await fetch(itunesUrl);
        const data = await response.json();
        if (data.resultCount > 0) {
            const bestMatch = data.results.find((r: { collectionName: string; }) => r.collectionName.toLowerCase() === album.toLowerCase()) || data.results[0];
            const highResUrl = bestMatch.artworkUrl100.replace('100x100', '1000x1000');
            console.log(`Successfully got album art from iTunes. ${highResUrl}`);
            return highResUrl;
        }
    } catch (error) {
        console.error("Error fetching from iTunes:", error);
    }

    console.log("iTunes failed, trying MusicBrainz / Cover Art Archive...");
    const musicBrainzArt = await findCoverOnMusicBrainz(artist, album);
    if (musicBrainzArt) return musicBrainzArt;

    console.log("All fallbacks failed.");
    return null;
}

export async function getDominantColor(imageUrl: string): Promise<number | null> {
    try {
        const palette = await Vibrant.from(imageUrl).getPalette();
        const vibrantSwatch = palette.Vibrant || palette.Muted || palette.LightVibrant;
        if (vibrantSwatch && vibrantSwatch.hex) {
            return parseInt(vibrantSwatch.hex.substring(1), 16);
        }
    } catch (error) {
        console.error("Error getting dominant color:", error);
    }
    return null;
}


export const getBaseUrl = () => {
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
        return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    }
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:2999';
};


export function encodeLoveId(userId: string, artist: string, track: string): string {
    const prefix = `love_fm_${userId}_`;
    const maxPayload = 99 - prefix.length; // leave 1 char buffer
    let payload = `${artist}||${track}`;
    if (payload.length > maxPayload) {
        payload = payload.substring(0, maxPayload);
    }
    return `${prefix}${payload}`;
}

