// app/commands/countdown.ts
import { NextResponse } from 'next/server';
import {
    APIChatInputApplicationCommandInteraction,
    APIMessageComponentButtonInteraction,
    InteractionResponseType,
    ComponentType,
    ButtonStyle,
} from 'discord-api-types/v10';

// This function is fine and can remain unchanged.
// It creates the initial message and buttons.
export function handleCountdown(interaction: APIChatInputApplicationCommandInteraction): NextResponse {
    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
            embeds: [
                {
                    title: 'Countdown Test',
                    description: 'Please press a button.',
                    color: 0x5865f2,
                },
            ],
            components: [
                {
                    type: ComponentType.ActionRow,
                    components: [
                        {
                            type: ComponentType.Button,
                            style: ButtonStyle.Success,
                            label: 'Test Start',
                            custom_id: 'start_countdown',
                        },
                        {
                            type: ComponentType.Button,
                            style: ButtonStyle.Danger,
                            label: 'Test Cancel',
                            custom_id: 'cancel_countdown',
                        },
                    ],
                },
            ],
        },
    });
}


/**
 * A simplified handler for button interactions.
 * This version removes ALL async logic to test the core response mechanism.
 */
export function handleCountdownInteraction(interaction: APIMessageComponentButtonInteraction): NextResponse {
    const { custom_id } = interaction.data;

    let responseData;

    if (custom_id === 'start_countdown') {
        // If "start" is clicked, we will try to immediately update the message.
        // No timer, no delay. Just a direct response.
        responseData = {
            embeds: [{
                title: 'Test Succeeded!',
                description: 'The "Start" button was successfully processed.',
                color: 0x57f287, // Green
            }],
            components: [], // Remove buttons
        };
    } else if (custom_id === 'cancel_countdown') {
        // If "cancel" is clicked, we do the same.
        responseData = {
            embeds: [{
                title: 'Test Succeeded!',
                description: 'The "Cancel" button was successfully processed.',
                color: 0xed4245, // Red
            }],
            components: [], // Remove buttons
        };
    } else {
        // Fallback for an unknown button
        responseData = {
            content: 'Unknown button was pressed.',
            embeds: [],
            components: [],
        };
    }
    
    // We are using InteractionResponseType.UpdateMessage.
    // This tells Discord to edit the message the button is attached to.
    // This is the simplest and most direct way to respond to a button click.
    return NextResponse.json({
        type: InteractionResponseType.UpdateMessage,
        data: responseData,
    });
}