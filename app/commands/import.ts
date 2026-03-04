import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataAttachmentOption,
} from 'discord-api-types/v10';
import { batchImportRatings } from '@/utils/database/ratings-service';

export async function handleImport(interaction: APIChatInputApplicationCommandInteraction) {
    const discordUserId = interaction.member!.user.id;
    const options = interaction.data.options ?? [];

    // Find the attachment option and explicitly cast it
    const fileOption = options.find(
        (opt) => opt.name === 'file'
    ) as APIApplicationCommandInteractionDataAttachmentOption | undefined;

    if (!fileOption || !interaction.data.resolved?.attachments) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ You must upload a CSV file.", flags: 64 }
        });
    }

    // Now TypeScript knows that `fileOption.value` exists and is a string!
    const attachmentId = fileOption.value;
    const attachment = interaction.data.resolved.attachments[attachmentId];

    if (!attachment.filename.endsWith('.csv')) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ Please upload a valid `.csv` file format.", flags: 64 }
        });
    }
    

    try {
        // Download the CSV file directly from Discord's CDN
        const response = await fetch(attachment.url);
        const text = await response.text();

        // Very lightweight CSV parser specific to RYM's strict double-quoted format
        const lines = text.trim().split('\n');
        
        const recordsToInsert = [];

        // Loop starting from 1 to skip the CSV Header column
        for (let i = 1; i < lines.length; i++) {
            // RYM strictly wraps every single field in "...", so strip the outer quotes
            // and split by "," to perfectly preserve internal characters (even commas inside titles)
            let unquotedLine = lines[i].trim();
            if (unquotedLine.startsWith('"')) unquotedLine = unquotedLine.substring(1);
            if (unquotedLine.endsWith('"')) unquotedLine = unquotedLine.substring(0, unquotedLine.length - 1);
            
            const columns = unquotedLine.split('","');

            // Columns based on RYM standard:
            // 0: RYM Album
            // 1: First Name
            // 2: Last Name
            // 3: First Name localized
            // 4: Last Name localized
            // 5: Title
            // 6: Release_Date
            // 7: Rating

            if (columns.length < 8) continue;

            const scoreStr = columns[7];
            if (!scoreStr) continue; // Skip if it isn't rated (e.g., they just cataloged it)
            
            const score = parseInt(scoreStr, 10);
            if (isNaN(score)) continue;

            // Handle localized name columns as a fallback if the primary names are missing or foreign
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
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: "❌ Found no valid ratings to import in the CSV.", flags: 64 }
            });
        }

        // Run batch insert
        await batchImportRatings(discordUserId, recordsToInsert);

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: `✅ Successfully imported **${recordsToInsert.length}** ratings into your profile!` }
        });

    } catch (e) {
        console.error("Failed to parse/import CSV: ", e);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "❌ Something went wrong while importing your file.", flags: 64 }
        });
    }
}