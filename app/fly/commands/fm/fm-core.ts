import { ButtonStyle, type APIEmbed, type APIActionRowComponent, type APIButtonComponent } from 'discord-api-types/v10';
import { syncAlbumCover, generateSlug } from '@/utils/database/album-service';
import { linkAlbumGenres } from '@/utils/database/genre-service';
import {
    cleanArtistName, isValidImageUrl, findCoverArt,
    getDominantColor, encodeLoveId, getBaseUrl,
} from './fm-helpers';

const NO_SYNC_USER = '508817156847173632';

export type FmReply =
    | { ok: true; embeds: APIEmbed[]; components: APIActionRowComponent<APIButtonComponent>[] }
    | { ok: false; message: string };

async function lfm(params: Record<string, string>) {
    const qs = new URLSearchParams({ ...params, api_key: process.env.LASTFM_API_KEY!, format: 'json' });
    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${qs}`);
    return res.json();
}

async function getDuration(artist: string, track: string): Promise<string> {
    try {
        const d = await lfm({ method: 'track.getInfo', artist, track });
        const ms = parseInt(d?.track?.duration);
        if (ms > 0) {
            const s = Math.floor(ms / 1000);
            return `-# ⏱ (${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')})`;
        }
    } catch (e) { console.error('Could not fetch track duration:', e); }
    return '';
}

async function getAlbumTags(artist: string, album: string): Promise<string[]> {
    if (!album) return [];
    try {
        const d = await lfm({ method: 'album.getInfo', artist, album });
        const tags = d?.album?.tags?.tag;
        if (Array.isArray(tags)) return tags.map((t: { name: string }) => t.name);
        if (tags && typeof tags === 'object') return [tags.name]; // single tag comes back as an object
    } catch (e) { console.error('Could not fetch album tags:', e); }
    return [];
}

export async function buildFmReply(o: {
    lastfmUsername: string;
    discordUserId: string;
    applyYoutubeFix: boolean;
}): Promise<FmReply> {
    const { lastfmUsername, discordUserId, applyYoutubeFix } = o;

    const data = await lfm({ method: 'user.getrecenttracks', user: lastfmUsername, limit: '1' });
    if (data.error || !data.recenttracks?.track?.length) {
        return { ok: false, message: `Could not find any recent tracks for user \`${lastfmUsername}\`.` };
    }

    const track = data.recenttracks.track[0];
    let artist: string = track.artist['#text'];
    const trackName: string = track.name;
    const albumName: string = track.album['#text'];
    if (applyYoutubeFix) artist = cleanArtistName(artist);

    const [formattedDuration, tags] = await Promise.all([
        getDuration(artist, trackName),
        getAlbumTags(artist, albumName),
    ]);

    let albumArtUrl: string | null =
        track.image.find((i: { size: string }) => i.size === 'extralarge')?.['#text']
        || track.image.find((i: { size: string }) => i.size === 'large')?.['#text']
        || track.image[track.image.length - 1]?.['#text'];

    if (!(await isValidImageUrl(albumArtUrl)) || albumArtUrl!.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
        albumArtUrl = await findCoverArt(artist, albumName);
    }
    if (!albumArtUrl) {
        return { ok: false, message: `Could not find album art for **${trackName}** by **${artist}**.` };
    }

    if (discordUserId !== NO_SYNC_USER) {
        // fire-and-forget is fine now: the process stays alive
        Promise.resolve(syncAlbumCover(artist, albumName, albumArtUrl, discordUserId))
            .catch(e => console.error('[syncAlbumCover]', e));
        if (tags.length > 0) {
            Promise.resolve(linkAlbumGenres(generateSlug(artist, albumName), tags, discordUserId))
                .catch(e => console.error('[linkAlbumGenres]', e));
        }
    }

    const dominantColor = await getDominantColor(albumArtUrl);
    let iconUrl = 'https://www.last.fm/static/images/lastfm_avatar_twitter.52a5d69a85ac.png';
    if (dominantColor) {
        // ICON_BASE_URL can point at Vercel until /api/recolor-icon is ported
        const base = process.env.ICON_BASE_URL ?? getBaseUrl();
        iconUrl = `${base}/api/recolor-icon?color=${dominantColor.toString(16).padStart(6, '0')}`;
    }

    const isNowPlaying = track['@attr']?.nowplaying;
    const footerText = isNowPlaying ? `Currently listening: ${lastfmUsername}` : `Last scrobbled by: ${lastfmUsername}`;
    const paddedTitle = trackName + '⠀'.repeat(Math.max(0, 20 - trackName.length));

    return {
        ok: true,
        embeds: [{
            title: paddedTitle,
            description: `${artist} •  ${albumName} \n${formattedDuration}`,
            color: dominantColor || 0xd51007,
            thumbnail: { url: albumArtUrl },
            footer: { text: footerText, icon_url: iconUrl },
        }],
        components: [{
            type: 1,
            components: [
                { type: 2, style: ButtonStyle.Secondary, label: 'Re-sync', custom_id: `resync_fm_${discordUserId}` },
                { type: 2, style: ButtonStyle.Secondary, label: '🖤', custom_id: encodeLoveId(discordUserId, artist, trackName) },
            ],
        }],
    };
}