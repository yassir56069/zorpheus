// app/commands/profile.ts
import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIEmbedField,
} from 'discord-api-types/v10';
import Parser from 'rss-parser';

const parser = new Parser();

/**
 * Converts a rating score string (e.g., "3.5") into a star representation.
 * @param {string} scoreString - The rating score.
 * @returns {string} - The formatted string of stars, e.g., "[ ★ ★ ★ ½ ]".
 */
function generateStarRating(scoreString?: string): string {
  if (!scoreString) return '';
  const score = parseFloat(scoreString);
  if (isNaN(score)) return '';

  const fullStar = '★';
  const halfStar = '½';
  let stars = '';

  const fullStars = Math.floor(score);
  const hasHalfStar = (score % 1) !== 0;

  for (let i = 0; i < fullStars; i++) {
    stars += fullStar + ' ';
  }

  if (hasHalfStar) {
    stars += halfStar;
  }
  
  return `[ ${stars.trim()} ]`;
}

/**
 * Formats a date string into "DD Month YYYY".
 * @param {string} dateString - The date string from the RSS feed.
 * @returns {string} - The formatted date, e.g., "09 August 2025".
 */
function formatDate(dateString?: string): string {
    if (!dateString) return '';
    try {
        const date = new Date(dateString);
        const day = date.toLocaleDateString('en-GB', { day: '2-digit' });
        const month = date.toLocaleDateString('en-GB', { month: 'long' });
        const year = date.toLocaleDateString('en-GB', { year: 'numeric' });
        return `${day} ${month} ${year}`;
    } catch (e) {
        return '';
    }
}


export async function handleProfile(interaction: APIChatInputApplicationCommandInteraction) {
    try {
        // 1. Get the attachment's metadata
        const attachments = interaction.data.resolved?.attachments;
        if (!attachments) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: '❌ Error: No attachments found in the interaction.' },
            });
        }
        // eslint-disable-next-line
        const attachmentId = (interaction.data.options?.[0] as any).value;
        const attachment = attachments[attachmentId];

        // 2. Validate the file type
        if (!attachment.content_type?.startsWith('text/plain') && !attachment.content_type?.startsWith('application/xml') && !attachment.content_type?.startsWith('application/xhtml+xml') && !attachment.content_type?.startsWith('text/html')) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: `❌ Please upload a valid .txt, .xml, or .html file. You uploaded a file of type \`${attachment.content_type}\`.` },
            });
        }

        // 3. Fetch and parse the file content
        const fileUrl = attachment.url;
        const response = await fetch(fileUrl);
        if (!response.ok) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: '❌ Could not fetch the attachment content from Discord.' },
            });
        }
        const rssText = await response.text();
        const feed = await parser.parseString(rssText);
        const rymUsername = feed.title?.split('by ')[1] || 'user';

        if (!feed.items || feed.items.length === 0) {
            return NextResponse.json({
                type: InteractionResponseType.ChannelMessageWithSource,
                data: { content: 'The provided feed has no recent activity.' },
            });
        }
        
        // 4. Create the embed fields from the RSS items
        const fields: APIEmbedField[] = feed.items.slice(0, 10).map(item => {
            const { title = '', link, pubDate } = item;
            const description = (item as any).content || '';

            let value = '';
            const formattedDate = formatDate(pubDate);

            const ratedRegex = /Rated (.*) by (.*) +(\d\.\d|\d) stars/;
            const ratedMatch = title.match(ratedRegex);

            const reviewedRegex = /Reviewed (.*) by (.*)/;
            const reviewedMatch = title.match(reviewedRegex);

            if (reviewedMatch) {
                const [, album, artist] = reviewedMatch;
                const headline = `## ${album} - ${artist}`;
                const reviewText = description ? description.replace(/<[^>]*>/g, '').trim() : 'Reviewed';
                
                value = `${headline}\n${reviewText}\n[View RYM Page](${link})\n-# on ${formattedDate}`;

            } else if (ratedMatch) {
                const [, album, artist, rating] = ratedMatch;
                const headline = `## ${album} - ${artist}`;
                const starRating = generateStarRating(rating);

                value = `${headline}\nRated \`${starRating}\`\n[View RYM Page](${link})\n-# on ${formattedDate}`;
            } else {
                const headline = `## ${title}`;
                value = `${headline}\n[View RYM Page](${link})\n-# on ${formattedDate}`;
            }

            return {
                name: '** **', // Blank name for spacing
                value: value,
                inline: false,
            };
        });

        // 5. Construct the final embed with the new fields
        const embed = {
            title: `Recent activity for ${rymUsername}`,
            url: `https://rateyourmusic.com/~${rymUsername}`,
            color: 0x8A2BE2,
            fields: fields,
             footer: {
                text: `Fetched from a user-provided RSS file`,
                icon_url: 'https://e.snmc.io/3.0/img/logo/sonemic-32.png',
            },
            timestamp: new Date().toISOString(),
        };

        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                embeds: [embed],
            },
        });

    } catch (error) {
        console.error('Failed to parse the attached file:', error);
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: '❌ Failed to parse the file. Please ensure it is the unmodified RSS feed from Rate Your Music.' },
        });
    }
}