// app/commands/profile.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import Parser from 'rss-parser';

// Initialize the parser without any custom fetch logic initially
const parser = new Parser();

export async function handleProfile(interaction: APIChatInputApplicationCommandInteraction) {
    const usernameOption = interaction.data.options?.[0] as APIApplicationCommandInteractionDataStringOption;
    const rymUsername = usernameOption.value;

    const rssUrl = `https://rateyourmusic.com/~${rymUsername}/data/rss`;

    try {
        // Step 1: Manually fetch the RSS feed with a User-Agent header
        const response = await fetch(rssUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
            },
        });

        // Step 2: Check if the fetch was successful
        if (!response.ok) {
            // Log the detailed error for debugging on Vercel
            console.error(`Failed to fetch RSS feed for ${rymUsername}. Status: ${response.status} ${response.statusText}`);
            // Also log the response body if possible, it might contain an error message
            const errorBody = await response.text();
            console.error('Response Body:', errorBody);

            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `Error fetching the RSS feed. The server responded with status ${response.status}. Please check the username and try again.` },
            });
        }

        // Step 3: Get the feed content as text
        const rssText = await response.text();

        // Step 4: Parse the text content
        const feed = await parser.parseString(rssText);

        if (!feed.items || feed.items.length === 0) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: 'No recent activity found for this user.' },
            });
        }
        
        // Take only the most recent 10 items to avoid a huge embed
        const items = feed.items.slice(0, 10); 

        // Format the description, parsing out the title and link
        const description = items.map(item => {
             // Clean up the title a bit for better display
            const cleanTitle = item.title?.replace(/(\r\n|\n|\r)/gm, " ").trim();
            return `• [${cleanTitle}](${item.link})`;
        }).join('\n');

        const embed = {
            title: `Recent activity for ${feed.title?.split('by ')[1] || rymUsername}`,
            url: feed.link,
            description: description,
            color: 0x0099ff, // A nice blue color
             footer: {
                text: `Fetched from Rate Your Music`,
                icon_url: 'https://e.snmc.io/3.0/img/logo/sonemic-32.png', // RYM/Sonemic favicon
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
        // This will now catch errors from the parsing step or other unexpected issues
        console.error(`An error occurred while processing the profile command for ${rymUsername}:`, error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Could not fetch or parse the RSS feed. Please ensure the username is correct and public.' },
        });
    }
}