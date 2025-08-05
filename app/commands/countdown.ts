// app/commands/countdown.ts
import { NextResponse } from 'next/server';
import {
    APIChatInputApplicationCommandInteraction,
    APIMessageComponentButtonInteraction,
    InteractionResponseType,
    ComponentType,
    ButtonStyle,
} from 'discord-api-types/v10';

// A simple promise-based delay function.
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Handles the initial `/countdown` command.
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
 * Handles the button interactions for the countdown command.
 * This function will now perform the ENTIRE countdown.
 */
export async function handleCountdownInteraction(interaction: APIMessageComponentButtonInteraction): Promise<NextResponse> {
    const { custom_id } = interaction.data;

    if (custom_id === 'cancel_countdown') {
        // This is a simple, immediate update. This logic is fine.
        return new NextResponse(JSON.stringify({
            type: InteractionResponseType.UpdateMessage,
            data: {
                embeds: [{
                    title: 'Countdown Cancelled',
                    description: 'The countdown was cancelled by the user.',
                    color: 0xed4245, // Red
                }],
                components: [], // Remove buttons
            },
        }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    if (custom_id === 'start_countdown') {
        const { token, application_id } = interaction;
        const webhookUrl = `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`;

        // STEP 1: Acknowledge the interaction immediately.
        // This is the most critical step. We send a deferred update response.
        // Discord now knows we received the click and won't time out.
        // We MUST do this within 3 seconds.
        await fetch(`https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: InteractionResponseType.DeferredMessageUpdate,
            }),
        });

        // STEP 2: Now that we've acknowledged, we can perform the long-running task.
        // The serverless function will stay alive to complete this block.
        try {
            for (let i = 5; i > 0; i--) {
                await fetch(webhookUrl, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        embeds: [{
                            title: 'Countdown in Progress...',
                            description: `**${i}**`,
                            color: 0xfee75c, // Yellow
                        }],
                        components: [], // Remove buttons
                    }),
                });
                await wait(1000); // Wait for 1 second
            }

            // Final "Go!" message
            await fetch(webhookUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: 'Countdown Complete!',
                        description: '**Go!**',
                        color: 0x57f287, // Green
                    }],
                }),
            });

        } catch (error) {
            console.error('Countdown failed during webhook updates:', error);
            // If anything goes wrong, inform the user.
            await fetch(webhookUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: 'An error occurred during the countdown.',
                    embeds: [],
                    components: [],
                }),
            });
        }
        
        // STEP 3: Return a final response to Vercel.
        // We've already handled all communication with Discord via fetch.
        // We just need to tell Vercel the function is done.
        return new NextResponse(null, { status: 204 });
    }

    // Fallback for any unknown custom_id
    return new NextResponse('Unknown button interaction', { status: 400 });
}