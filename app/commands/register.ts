// app/commands/register.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    // Import the more specific type
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataStringOption,
} from 'discord-api-types/v10';
import { kv } from '@vercel/kv';

// Use the specific type in the function signature
export async function handleRegister(interaction: APIChatInputApplicationCommandInteraction) {
    const discordUserId = interaction.member!.user.id;

    // Now TypeScript knows that interaction.data WILL have an options property.
    const usernameOption = interaction.data.options?.[0] as APIApplicationCommandInteractionDataStringOption;
    const lastfmUsername = usernameOption.value;

    await kv.set(discordUserId, lastfmUsername);

    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: `✅ Success! Your Last.fm username has been saved as \`${lastfmUsername}\`.` },
    });
}