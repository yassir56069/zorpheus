import { NextResponse } from 'next/server';
import {
    InteractionResponseType,
    APIChatInputApplicationCommandInteraction,
    APIApplicationCommandInteractionDataUserOption,
} from 'discord-api-types/v10';

const CUSTOM_BAN_MESSAGES: Record<string, (username: string) => string> = {
    '508817156847173632': (username: string) => `**${username}** has been permanently removed from poland`,  // sars
    '975283884377903185': (username: string) => `**${username}** Banned for 1 minute; Stoicism aura break 🗿`,  // sabo
    '689625367149019255': (username: string) => `**${username}** has been removed from all board game federations`, // witch
    '869190314408169524': (username: string) => `**${username}** REMOVED. BANNED. PERMANENT.`, // angel
    '471037538497331221': (username: string) => `ALL J-POP ARTISTS HAVE BEEN PERMANENTLY RELOCATED TO DELARE AND THEY ARE **NEVER** COMING BACK. **${username}** REMOVED. `, // birds
    '959791198938230784': (username: string) => `**${username}** : https://tenor.com/view/daniel-dae-kim-mogged-mogger-looksmaxxing-ruggyscruggy-gif-1507416034755076487 `,  // deks
    '237238938283147265': (username: string) => `CHARLIE KIRK HAS PASSED AWAY. WELCOME!`, // charlie kirk
    '674797171857686568': (username: string) => `**${username}** - Mana crypt rated this one a 2.5 `, // glasses
    '1137892277612711996': (username: string) => `**${username}** banned for existing #evil`, // kenops
    '373301028986290186': (username: string) => `**${username}** - all guitars are now left-handed. suck it. banned. `, // fungus
    '696806892793626664': (username: string) => `**${username}** - literally who watches the wiggles. permanently removed for 30 seconds.`, // wiggles
    '530532463596929034': (username: string) => `**${username}** - richard dawson isn't even THAT good!!! go to bed !`, // stalemate
    '306226778752417792': (username: string) => `**${username}** https://tenor.com/view/chiikawa-dance-happy-u-uwa-wa-uwa-gif-12488488499303603624`, // taco
    // add more user IDs here
};

const BAN_REASONS = [
    (username: string) => `**${username}** Welcome to the Zorpheus Discord Server, you have been permanently banned!! ⭐ `,
    (username: string) => `**${username}**; just so you know, sars wrote 3 paragraphs about you after you left.`,
    (username: string) => `🚨 Sarsparilla has been banned for saying "I'll just quickly explain" and then talking for 45 minutes straight.`,
    (username: string) => `**${username}** has been banned for living in Bosnia`,
    (username: string) => `📋 **${username}** has been banned for saying Perchance.`,
    (username: string) => `**${username}** has been banned for not praciticing Stoicism`,
    (username: string) => `Did you know? we have our own server charts and ratings! - **${username}** has been permanently banned!`,
    (username: string) => `**POST ROCK** IS BANNED. MUSIC IS **BANNED**.`,
    (username: string) => `We are so happy to remove you, right now! **${username}** has been permanently executed! `,
    (username: string) => `To negate this ban please send me an email describing every beautiful thing about me, the wonderful owner. Kisses 💅💅 `,
    (username: string) => `🧂 **${username}** has been banned after an independent audit found their takes to be excessively salty. Sodium levels: critical.`,
    (username: string) => `Every person in Poland wil be removed indefinitely`,
    (username: string) => `📱 **${username}** has been banned for leaving voice messages instead of just texting like a normal person.`,
    (username: string) => `🐛 **ZORPHEUS OWNER SUPREME** has been banned for pushing directly to main. On a Friday. Before a long weekend.`,
    (username: string) => `PINK FLOYD IS DEAD. BREAKING NEWS. BANNED.`,
];

export async function handleBan(interaction: APIChatInputApplicationCommandInteraction) {
    const options = interaction.data.options ?? [];

    const targetOpt = options.find(opt => opt.name === 'user') as APIApplicationCommandInteractionDataUserOption | undefined;
    const targetUserId = targetOpt?.value;

    if (!targetUserId) {
        return NextResponse.json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Zorpheus has been banned! oh no!' },
        });
    }

    const resolvedUser = interaction.data.resolved?.users?.[targetUserId];
    const username = resolvedUser?.global_name || resolvedUser?.username || `<@${targetUserId}>`;

    const customMessage = CUSTOM_BAN_MESSAGES[targetUserId];
    const banMessage = customMessage
        ? customMessage(username)
        : BAN_REASONS[Math.floor(Math.random() * BAN_REASONS.length)](username);

    return NextResponse.json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
            content: `${banMessage}`,
        },
    });
}