// app/api/recolor-icon/route.ts
import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

// The original, static URL for the Last.fm icon
const LASTFM_ICON_URL = 'https://www.last.fm/static/images/lastfm_avatar_twitter.52a5d69a85ac.png';

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        // Get the hex color from the query, default to Last.fm red if not provided
        const color = `#${searchParams.get('color') || 'd51007'}`;

        // 1. Fetch the original icon image as a buffer
        const imageResponse = await fetch(LASTFM_ICON_URL);
        if (!imageResponse.ok) {
            throw new Error('Failed to fetch original icon');
        }
        const originalIconBuffer = Buffer.from(await imageResponse.arrayBuffer());

        // 2. Use sharp to tint the image
        // The .tint() method is perfect for this. It preserves the alpha channel (transparency).
        const modifiedIconBuffer = await sharp(originalIconBuffer)
            .tint(color)
            .png() // Ensure the output is PNG
            .toBuffer();

        // 3. Return the new image as a response
        // We set cache headers to tell Discord/browsers to cache this image for a very long time.
        // If someone requests the same color again, it will be served from cache, saving resources.
        return new NextResponse(modifiedIconBuffer, {
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, immutable, no-transform, s-maxage=31536000, max-age=31536000',
            },
        });

    } catch (error) {
        console.error('Error in recolor-icon route:', error);
        return new NextResponse('Error generating image', { status: 500 });
    }
}