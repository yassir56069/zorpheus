// app/commands/profile.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import Parser from 'rss-parser';

const parser = new Parser();

export async function handleProfile(interaction: APIChatInputApplicationCommandInteraction) {
    const usernameOption = interaction.data.options?.[0] as APIApplicationCommandInteractionDataStringOption;
    const rymUsername = usernameOption.value;

    const originalRssUrl = `https://rateyourmusic.com/~${rymUsername}/data/rss`;
    
    // *** THE FIX: Prepend a proxy to the URL ***
    // This makes the request originate from the proxy's server, bypassing IP blocks.
    const proxiedRssUrl = `https://proxy.cors.sh/${originalRssUrl}`;

    // We keep the browser headers. Even though the proxy helps, it's best practice.
    const browserHeaders = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
        // Add the x-cors-api-key for the proxy service
        'x-cors-api-key': 'temp_22b27271922a7f5080c54b204e3fb458'
    };

    try {
        const response = await fetch(proxiedRssUrl, {
            headers: browserHeaders,
        });

        if (!response.ok) {
            console.error(`Failed to fetch via proxy for ${rymUsername}. Status: ${response.status} ${response.statusText}`);
            const errorBody = await response.text();
            console.error('Proxy Response Body:', errorBody.slice(0, 500));

            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Error fetching the RSS feed via proxy. The proxy responded with status ${response.status}.` },
            });
        }

        const rssText = await response.text();
        const feed = await parser.parseString(rssText);

        if (!feed.items || feed.items.length === 0) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: 'No recent activity found for this user.' },
            });
        }
        
        const items = feed.items.slice(0, 10); 

        const description = items.map(item => {
            const cleanTitle = item.title?.replace(/(\r\n|\n|\r)/gm, " ").trim();
            return `• [${cleanTitle}](${item.link})`;
        }).join('\n');

        const embed = {
            title: `Recent activity for ${feed.title?.split('by ')[1] || rymUsername}`,
            url: `https://rateyourmusic.com/~${rymUsername}`,
            description: description,
            color: 0x8A2BE2,
             footer: {
                text: `Fetched from Rate Your Music`,
                icon_url: 'https://e.snmc.io/3.0/img/logo/sonemic-32.png',
            },
            timestamp: new Date().toISOString(),
        };

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                embeds: [embed],
            },
        });
    } catch (error) {
        console.error(`An error occurred while processing the proxied profile command for ${rymUsername}:`, error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Could not fetch or parse the RSS feed. Please ensure the username is correct and public.' },
        });
    }
}