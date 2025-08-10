// app/commands/profile.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
} from 'discord-api-types/v10';
import Parser from 'rss-parser';

const parser = new Parser();

export async function handleProfile(interaction: APIChatInputApplicationCommandInteraction) {
    try {
        // 1. Get the attachment's metadata from the interaction payload
        const attachments = interaction.data.resolved?.attachments;
        if (!attachments) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: '❌ Error: No attachments found in the interaction.' },
            });
        }

        // eslint-disable-next-line
        const attachmentId = (interaction.data.options?.[0] as any).value;
        const attachment = attachments[attachmentId];

        // 2. Validate the file type (optional but good practice)
        // *** THIS IS THE MODIFIED LINE ***
        if (!attachment.content_type?.startsWith('text/plain') && !attachment.content_type?.startsWith('application/xml') && !attachment.content_type?.startsWith('application/xhtml+xml') && !attachment.content_type?.startsWith('text/html')) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `❌ Please upload a valid .txt, .xml, or .html file. You uploaded a file of type \`${attachment.content_type}\`.` },
            });
        }

        // 3. Fetch the content of the file from Discord's CDN
        const fileUrl = attachment.url;
        const response = await fetch(fileUrl);
        if (!response.ok) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: '❌ Could not fetch the attachment content from Discord.' },
            });
        }
        const rssText = await response.text();

        // 4. Parse the file content
        const feed = await parser.parseString(rssText);
        const rymUsername = feed.title?.split('by ')[1] || 'user';


        if (!feed.items || feed.items.length === 0) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: 'The provided feed has no recent activity.' },
            });
        }
        
        const items = feed.items.slice(0, 10); 

        const description = items.map(item => {
            const cleanTitle = item.title?.replace(/(\r\n|\n|\r)/gm, " ").trim();
            return `• [${cleanTitle}](${item.link})`;
        }).join('\n');

        const embed = {
            title: `Recent activity for ${rymUsername}`,
            url: `https://rateyourmusic.com/~${rymUsername}`,
            description: description,
            color: 0x8A2BE2,
             footer: {
                text: `Fetched from a user-provided RSS file`,
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
        console.error('Failed to parse the attached file:', error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: '❌ Failed to parse the file. Please ensure it is the unmodified RSS feed from Rate Your Music.' },
        });
    }
}