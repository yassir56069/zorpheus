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
                    description: 'Press the button to start the countdown.',
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
 * Edits the original interaction response.
 * @param token The interaction token.
 * @param applicationId The application ID.
 * @param data The new message data.
 */
async function editOriginalResponse(token: string, applicationId: string, data: any) {
    const endpoint = `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`;
    
    await fetch(endpoint, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
    });
}


/**
 * Handles the button interactions for the countdown command.
 * @param interaction The button component interaction.
 */
export function handleCountdownInteraction(interaction: APIMessageComponentButtonInteraction) {
    const { custom_id } = interaction.data;
    const { token, application_id } = interaction;

    if (custom_id === 'start_countdown') {
        // Use an IIFE to run the countdown asynchronously
        (async () => {
            try {
                for (let i = 5; i > 0; i--) {
                    await editOriginalResponse(token, application_id, {
                        embeds: [{
                            title: 'Countdown',
                            description: `**${i}**`,
                            color: 0xfee75c, // Yellow
                        }],
                        components: [], // Remove buttons
                    });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                await editOriginalResponse(token, application_id, {
                    embeds: [{
                        title: 'Countdown',
                        description: '**Go!**',
                        color: 0x57f287, // Green
                    }],
                });
            } catch (error) {
                console.error('Countdown failed:', error);
            }
        })();

        // Acknowledge the button press immediately
        return NextResponse.json({ type: InteractionResponseType.DeferredMessageUpdate });
    }

    if (custom_id === 'cancel_countdown') {
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