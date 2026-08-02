import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataBasicOption,
} from 'discord-api-types/v10';
import { adjustUserFeaturePoints } from '@/utils/database/feature-service';

export async function handleGiveFeaturePoints(
    interaction: APIChatInputApplicationCommandInteraction
) {
    const options = interaction.data.options;
    if (!options) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: '❌ Missing command arguments.', flags: 64 }
        });
    }

    // Cast the found options to basic option types to access the .value property safely
    const userOption = options.find(opt => opt.name === 'user') as APIApplicationCommandInteractionDataBasicOption | undefined;
    const pointsOption = options.find(opt => opt.name === 'points') as APIApplicationCommandInteractionDataBasicOption | undefined;

    if (!userOption || !pointsOption) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: '❌ Both user and points options are required.', flags: 64 }
        });
    }

    const targetUserId = userOption.value as string;
    const pointsAmount = pointsOption.value as number;

    try {
        const newTotal = await adjustUserFeaturePoints(targetUserId, pointsAmount);

        const description = pointsAmount >= 0 
            ? `Added **${pointsAmount}** points to` 
            : `Deducted **${Math.abs(pointsAmount)}** points from`;

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `🏆 **Feature Points Updated!**\n${description} <@${targetUserId}>. They now have **${newTotal}** total points.`
            }
        });
    } catch (error) {
        console.error('[ADMIN] Error adjusting feature points:', error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: '❌ Failed to update points due to an internal database error.', flags: 64 }
        });
    }
}