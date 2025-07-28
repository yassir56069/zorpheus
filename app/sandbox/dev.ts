import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';

// Import your testable commands here
import { handleCover } from './cover.dev';
import { handleFm } from './fm.dev';

/**
 * Routes developer commands based on a key.
 * This command is restricted to users whose IDs are in DEVELOPER_IDS.
 */
export async function handleDev(interaction: APIChatInputApplicationCommandInteraction) {
    // --- 1. Authorization ---
    const developerIds = (process.env.DEVELOPER_IDS || '').split(',');
    const callingUserId = interaction.member?.user?.id;

    if (!callingUserId || !developerIds.includes(callingUserId)) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: '🚫 This command is restricted to developers only.',
                flags: 1 << 6, // Ephemeral message
            },
        });
    }

    // --- 2. Get the Command Key and Value ---
    const options = interaction.data.options as APIApplicationCommandInteractionDataStringOption[];
    const commandKey = options.find(opt => opt.name === 'key')?.value;
    const commandValue = options.find(opt => opt.name === 'value')?.value; // Optional value

    if (!commandKey) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: 'You must provide a command key. Available keys: `test-cover`, `test-ping`.',
                flags: 1 << 6,
            },
        });
    }

    console.log(`Developer command triggered: '${commandKey}' by user ${callingUserId}`);

    // --- 3. Route to the Test Command ---
    switch (commandKey.toLowerCase()) {
        case 'test-cover':
            // You might need to adjust the interaction object passed to handleCover
            // if it expects specific options that aren't present in the /dev command.
            // For now, we'll assume it can run without extra options for a default test.
            return handleCover(interaction);

        case 'test-fm':
            // You might need to adjust the interaction object passed to handleCover
            // if it expects specific options that aren't present in the /dev command.
            // For now, we'll assume it can run without extra options for a default test.
            return handleFm(interaction);

        // Add more test cases here
        // case 'test-new-feature':
        //     return handleNewFeature(interaction, commandValue);

        default:
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: {
                    content: `Unknown developer command key: \`${commandKey}\`.`,
                    flags: 1 << 6,
                },
            });
    }
}