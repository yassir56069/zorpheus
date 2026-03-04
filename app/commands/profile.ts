// app/commands/profile.ts
import { NextResponse } from 'next/server';
import {
    APIChatInputApplicationCommandInteraction,
    APIMessageComponentButtonInteraction,
    InteractionResponseType,
    ComponentType,
    ButtonStyle
} from 'discord-api-types/v10';
import { getUserRatingDistribution, getUserRecentRatings } from '@/utils/database/ratings-service';
import { getUserDisplayName } from '@/utils/database/user-service';

// --- Helper UI Functions ---

function generateRatingChart(distribution: Array<{ score: number, count: number }>) {
    const counts = new Map(distribution.map(d => [d.score, d.count]));
    const maxCount = Math.max(...distribution.map(d => d.count), 1);
    const MAX_BAR_LENGTH = 15; // Width of the graph

    let chartText = '```text\n';
    for (let score = 10; score >= 1; score--) {
        const count = counts.get(score) || 0;
        
        // Calculate Bar
        const barLength = Math.round((count / maxCount) * MAX_BAR_LENGTH);
        const bar = count > 0 ? '█'.repeat(barLength) || '▏' : ''; // '▏' ensures a 1-pixel bar if > 0 but very small
        
        // Calculate Stars
        const fullStars = Math.floor(score / 2);
        const halfStar = score % 2 !== 0;
        const stars = '★'.repeat(fullStars) + (halfStar ? '½' : '') + '☆'.repeat(5 - fullStars - (halfStar ? 1 : 0));

        // Format and align layout
        const paddedCount = count.toString().padStart(4, ' ');
        const paddedBar = bar.padEnd(MAX_BAR_LENGTH, ' ');

        chartText += `${paddedCount} ${paddedBar} ${stars}\n`;
    }
    chartText += '```';
    return chartText;
}

async function buildProfilePayload(userId: string, activeTab: 'overview' | 'recent') {
    // Attempt to get users custom display name, fallback to a default (we don't have the discord user object easily here if clicked by someone else)
    const displayName = await getUserDisplayName(userId) || `<@${userId}>`;

    const embed = {
        title: ``,
        description: ``,
        color: 0x2b2d31, // Discord dark theme color
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fields: [] as any[]
    };

    if (activeTab === 'overview') {
        const dist = await getUserRatingDistribution(userId);
        const totalRatings = dist.reduce((acc, curr) => acc + curr.count, 0);
        
        const avgCalculation = totalRatings > 0 
            ? (dist.reduce((acc, curr) => acc + (curr.score * curr.count), 0) / totalRatings / 2).toFixed(2)
            : '0.00';

        embed.title = `📊 Rating Overview`;
        embed.description = `**Total Ratings:** ${totalRatings}\n**Average Rating:** ${avgCalculation} ★\n\n` + 
                            (totalRatings > 0 ? generateRatingChart(dist) : "*User has no ratings yet.*");
    } 
    else if (activeTab === 'recent') {
        const recent = await getUserRecentRatings(userId, 10); // get last 10
        
        embed.title = `🕒 Recent Ratings`;
        embed.description = recent.length > 0 
            ? recent.map(r => `**${r.score / 2}** ★ \`${r.artistName} - ${r.albumName}\``).join('\n')
            : "*User has no recent ratings.*";
    }

    const components = [{
        type: ComponentType.ActionRow,
        components: [
            {
                type: ComponentType.Button,
                style: activeTab === 'overview' ? ButtonStyle.Primary : ButtonStyle.Secondary,
                label: 'Overview',
                custom_id: `profile_overview_${userId}`,
                disabled: activeTab === 'overview' // Disable the active button
            },
            {
                type: ComponentType.Button,
                style: activeTab === 'recent' ? ButtonStyle.Primary : ButtonStyle.Secondary,
                label: 'Recent Ratings',
                custom_id: `profile_recent_${userId}`,
                disabled: activeTab === 'recent'
            }
        ]
    }];

    return {
        embeds: [embed],
        components
    };
}


// --- Interaction Handlers ---

export async function handleProfile(interaction: APIChatInputApplicationCommandInteraction) {
    // Check if the command was run on a specific user, otherwise default to the invoker
    // Assumes your slash command has an optional "user" option
    const options = interaction.data.options;
    
    // @ts-expect-error - bypassing strict type checking for the option array search
    const targetUserId = (options?.find(opt => opt.name === 'user')?.value as string) 
                         || interaction.member?.user.id 
                         || interaction.user?.id;

    // 1. Add this check to guarantee to TypeScript that targetUserId is a string
    if (!targetUserId) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "Error: Could not determine the user.", flags: 64 }
        });
    }
    const payload = await buildProfilePayload(targetUserId, 'overview');

    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
            content: `Profile for <@${targetUserId}>`,
            embeds: payload.embeds,
            components: payload.components
        }
    });
}

export async function handleProfileButtonInteraction(interaction: APIMessageComponentButtonInteraction) {
    const customId = interaction.data.custom_id;
    
    // customId format: "profile_{tab}_{userId}"
    const parts = customId.split('_');
    const tab = parts[1] as 'overview' | 'recent';
    const targetUserId = parts[2];

    const payload = await buildProfilePayload(targetUserId, tab);

    return NextResponse.json({
        type: InteractionResponseType.UpdateMessage, // Edits the existing message!
        data: {
            embeds: payload.embeds,
            components: payload.components
        }
    });
}