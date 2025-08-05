// app/commands/countdown.ts
import { NextResponse } from 'next/server';
import {
    APIChatInputApplicationCommandInteraction,
    APIMessageComponentButtonInteraction,
    InteractionResponseType,
    ComponentType,
    ButtonStyle,
} from 'discord-api-types/v10';

/**
 * Handles the initial `/countdown` command.
 * @param interaction The chat input command interaction.
 * @returns A NextResponse with the initial embed and buttons.
 */
export function handleCountdown(interaction: APIChatInputApplicationCommandInteraction) {
    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
            embeds: [
                {
                    title: 'Countdown',
                    description: 'Ready to start the countdown?',
                    color: 0x5865f2, // Discord Blurple
                },
            ],
            components: [
                {
                    type: ComponentType.ActionRow,
                    components: [
                        {
                            type: ComponentType.Button,
                            style: ButtonStyle.Success,
                            label: 'Start',
                            custom_id: 'start_countdown',
                        },
                        {
                            type: ComponentType.Button,
                            style: ButtonStyle.Danger,
                            label: 'Cancel',
                            custom_id: 'cancel_countdown',
                        },
                    ],
                },
            ],
        },
    });
}

/**
 * Edits the original interaction response using a webhook PATCH request.
 * @param token The interaction token.
 * @param applicationId The application ID.
 * @param data The new message data to patch.
 */
async function editOriginalResponse(token: string, applicationId: string, data: any) {
    const endpoint = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;

    // We use a fetch request to the webhook to edit the message.
    // This is how you update a message after the initial response has been sent.
    const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        console.error(`Failed to edit original response: ${res.status}`);
        const errorText = await res.text();
        console.error(errorText);
    }
}


/**
 * A simple promise-based delay function.
 * @param ms Milliseconds to wait.
 */
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


/**
 * Runs the countdown logic asynchronously.
 * This function is designed to be called without being awaited ("fire and forget").
 * @param token The interaction token.
 * @param applicationId The application ID.
 */
async function runCountdown(token: string, applicationId: string) {
    try {
        for (let i = 5; i > 0; i--) {
            await editOriginalResponse(token, applicationId, {
                embeds: [{
                    title: 'Countdown',
                    description: `**${i}**`,
                    color: 0xfee75c, // Yellow
                }],
                components: [], // Remove buttons after starting
            });
            await wait(1000); // Wait for 1 second
        }

        // Final message
        await editOriginalResponse(token, applicationId, {
            embeds: [{
                title: 'Countdown Complete',
                description: '**Go!**',
                color: 0x57f287, // Green
            }],
        });
    } catch (error) {
        console.error('Countdown failed:', error);
        // If the countdown fails, edit the message to show an error
        await editOriginalResponse(token, applicationId, {
            embeds: [{
                title: 'Countdown Failed',
                description: 'An error occurred during the countdown.',
                color: 0xed4245, // Red
            }],
            components: [],
        });
    }
}


/**
 * Handles the button interactions for the countdown command.
 * @param interaction The button component interaction.
 */
export function handleCountdownInteraction(interaction: APIMessageComponentButtonInteraction) {
    const { custom_id } = interaction.data;
    const { token, application_id } = interaction;

    if (custom_id === 'start_countdown') {
        // --- THIS IS THE KEY CHANGE ---
        // We do NOT await runCountdown. We call it, and it runs in the background.
        // The serverless function returns a response to Discord immediately,
        // allowing the async countdown to complete without timing out.
        runCountdown(token, application_id);

        // Acknowledge the button press immediately so Discord knows we received it.
        // This stops the "interaction failed" message on the button itself.
        return NextResponse.json({
             type: InteractionResponseType.UpdateMessage,
             data: {
                embeds: [{
                    title: 'Countdown',
                    description: 'Starting...',
                    color: 0xfee75c,
                }],
                components: []
             }
        });
    }

    if (custom_id === 'cancel_countdown') {
        // This is a final state, so we can just update the message directly.
        return NextResponse.json({
            type: InteractionResponseType.UpdateMessage,
            data: {
                embeds: [{
                    title: 'Countdown',
                    description: 'Countdown cancelled.',
                    color: 0xed4245, // Red
                }],
                components: [], // Remove buttons
            },
        });
    }

    return new NextResponse('Unknown button interaction', { status: 400 });
}