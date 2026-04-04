import { NextResponse } from 'next/server';
import { getSessionKey } from '@/utils/lastfm-auth';
import { saveLastFMSessionKey } from '@/utils/database/user-service';
import { loveTrack } from '@/utils/lastfm-auth';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');
    const discordUserId = searchParams.get('state'); // we pass discord user ID as `state`
    const pendingArtist = searchParams.get('artist');
    const pendingTrack = searchParams.get('track');

    if (!token || !discordUserId) {
        return new NextResponse('Missing token or state', { status: 400 });
    }

    try {
        // Exchange token for session key and persist it
        const sessionKey = await getSessionKey(token);
        await saveLastFMSessionKey(discordUserId, sessionKey);

        // If there's a pending track to love, love it now
        if (pendingArtist && pendingTrack) {
            await loveTrack(
                decodeURIComponent(pendingArtist),
                decodeURIComponent(pendingTrack),
                sessionKey
            );
        }

        // DM the user to let them know it worked
        // First, open a DM channel
        const dmChannelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            },
            body: JSON.stringify({ recipient_id: discordUserId }),
        });
        const dmChannel = await dmChannelRes.json();

        if (dmChannel.id) {
            const dmMessage = pendingArtist && pendingTrack
                ? `✅ Your Last.fm account is now connected! **${decodeURIComponent(pendingTrack)}** by **${decodeURIComponent(pendingArtist)}** has been loved. Future 🖤 presses will work instantly.`
                : `✅ Your Last.fm account is now connected! Future 🖤 presses will work instantly.`;

            await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
                },
                body: JSON.stringify({ content: dmMessage }),
            });
        }

        // Return a friendly HTML page
        return new NextResponse(
            `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4rem;background:#111;color:#fff">
                <h1>✅ Connected!</h1>
                <p>${pendingArtist ? `<strong>${decodeURIComponent(pendingTrack!)}</strong> has been loved on Last.fm.<br><br>` : ''}Your Last.fm account is now linked. You can close this tab.</p>
            </body></html>`,
            { headers: { 'Content-Type': 'text/html' } }
        );
    } catch (err) {
        console.error('[Last.fm OAuth Callback Error]', err);
        return new NextResponse(
            `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4rem;background:#111;color:#ff4444">
                <h1>❌ Something went wrong</h1>
                <p>Could not connect your Last.fm account. Please try again.</p>
            </body></html>`,
            { headers: { 'Content-Type': 'text/html' } }
        );
    }
}