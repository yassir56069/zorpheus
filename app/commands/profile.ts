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

    // The target URL we want to access
    const targetUrl = `https://rateyourmusic.com/~${rymUsername}/data/rss`;

    // *** THE NEW FIX: Use the AllOrigins proxy ***
    // We encode the target URL and pass it as a query parameter.
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;

    try {
        // Fetch from the AllOrigins proxy. No special headers are needed for the proxy itself.
        const response = await fetch(proxyUrl);

        if (!response.ok) {
            console.error(`Failed to fetch via AllOrigins proxy for ${rymUsername}. Status: ${response.status}`);
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Error fetching the RSS feed. The proxy responded with status ${response.status}.` },
            });
        }

        // The AllOrigins proxy returns a JSON object. We need to parse it first.
        const jsonResponse = await response.json();
        
        // The actual RSS feed content is in the 'contents' property of the JSON response.
        const rssText = jsonResponse.contents;

        if (!rssText) {
             console.error(`AllOrigins proxy returned empty content for ${rymUsername}. The source URL might be blocked or invalid.`);
             // We can even check the status from the proxy's response to see what RYM returned
             console.error('Original fetch status reported by proxy:', jsonResponse.status);
             return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: 'The proxy could not retrieve the content. The Rate Your Music profile may be private, invalid, or temporarily unavailable.' },
            });
        }

        // Now we can parse the extracted RSS content
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