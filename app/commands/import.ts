import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions'; 
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataAttachmentOption,
} from 'discord-api-types/v10';
import { batchImportRatings } from '@/utils/database/ratings-service';

export async function handleImport(interaction: APIChatInputApplicationCommandInteraction) {
    const discordUserId = interaction.member!.user.id;
    const options = interaction.data.options ?? [];

    const fileOption = options.find(
        (opt) => opt.name === 'file'
    ) as APIApplicationCommandInteractionDataAttachmentOption | undefined;

    if (!fileOption || !interaction.data.resolved?.attachments) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ You must upload a CSV file.", flags: 64 }
        });
    }

    const attachmentId = fileOption.value;
    const attachment = interaction.data.resolved.attachments[attachmentId];

    if (!attachment.filename.endsWith('.csv')) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ Please upload a valid `.csv` file format.", flags: 64 }
        });
    }

    // --- BACKGROUND TASK ---
    // We define the heavy lifting in an async function so we can execute it without awaiting it
    const processImport = async () => {
        try {
            const response = await fetch(attachment.url);
            const text = await response.text();
            
            const lines = text.trim().split('\n');
            const recordsToInsert = [];

            for (let i = 1; i < lines.length; i++) {
                let unquotedLine = lines[i].trim();
                if (unquotedLine.startsWith('"')) unquotedLine = unquotedLine.substring(1);
                if (unquotedLine.endsWith('"')) unquotedLine = unquotedLine.substring(0, unquotedLine.length - 1);
                
                const columns = unquotedLine.split('","');
                if (columns.length < 8) continue;

                const scoreStr = columns[7];
                if (!scoreStr) continue; 
                
                const score = parseInt(scoreStr, 10);
                if (isNaN(score)) continue;

                const firstName = columns[3] || columns[1];
                const lastName = columns[4] || columns[2];
                const artistName = [firstName, lastName].filter(Boolean).join(' ').trim();
                const albumName = columns[5].trim();
                const releaseYear = columns[6].trim();

                if (!artistName || !albumName) continue;

                recordsToInsert.push({
                    artistName,
                    albumName,
                    releaseYear,
                    score
                });
            }

            if (recordsToInsert.length === 0) {
                await updateDiscordInteraction(interaction, "❌ Found no valid ratings to import in the CSV.");
                return;
            }

            // Run Turso batch insert (this chunks automatically so it handles thousands perfectly)
            await batchImportRatings(discordUserId, recordsToInsert);

            // Once finished, PATCH the original "thinking" message with the final count!
            await updateDiscordInteraction(
                interaction, 
                `✅ **Import Complete!** Successfully processed and imported **${recordsToInsert.length}** ratings into your profile.`
            );

        } catch (e) {
            console.error("Failed to parse/import CSV: ", e);
            await updateDiscordInteraction(interaction, "❌ Something went wrong while importing your file.");
        }
    };

    // Fire the background task
    // If you notice Vercel sometimes stops the bot from sending the final update message, 
    // run `npm install @vercel/functions` and wrap the call like this: waitUntil(processImport());
    waitUntil(processImport());

    // IMMEDIATELY return the deferred response to Discord (under 3 seconds)
    // This tells Discord to show "Bot is thinking..." in the channel
    return NextResponse.json({
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: {
            flags: 64 // Remove this line if you want the "thinking..." state to be public instead of ephemeral
        }
    });
}

/**
 * Helper function to edit the "Bot is thinking..." message
 * using Discord's Webhook API.
 */
async function updateDiscordInteraction(interaction: APIChatInputApplicationCommandInteraction, content: string) {
    const appId = interaction.application_id;
    const token = interaction.token;
    
    // Discord Webhook URL for patching original interaction responses
    const url = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;

    await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
    });
}