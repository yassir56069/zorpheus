// app/commands/profile.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
    ButtonStyle,
    ComponentType,
} from 'discord-api-types/v10';
import Parser from 'rss-parser';

const parser = new Parser();

export async function handleProfile(interaction: APIChatInputApplicationCommandInteraction) {
    const usernameOption = interaction.data.options?.[0] as APIApplicationCommandInteractionDataStringOption;
    const rymUsername = usernameOption.value;

    const rssUrl = `https://rateyourmusic.com/~${rymUsername}/data/rss`;

    try {
        const feed = await parser.parseURL(rssUrl);

        if (!feed.items || feed.items.length === 0) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: 'No recent activity found for this user.' },
            });
        }

        const items = feed.items.slice(0, 5); // Display the 5 most recent items

        const embed = {
            title: `Recent activity for ${rymUsername}`,
            description: items.map(item => `[${item.title}](${item.link})`).join('\n'),
            color: 0x0099ff,
        };

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                embeds: [embed],
            },
        });
    } catch (error) {
        console.error(error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Could not fetch the RSS feed. Make sure the username is correct.' },
        });
    }
}