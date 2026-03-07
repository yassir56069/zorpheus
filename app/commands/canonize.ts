import { canonizeAlbum } from '@/utils/database/album-service'; // Add this to your imports

export async function handleCanonizeAlbum(
    interaction: APIChatInputApplicationCommandInteraction, 
    waitUntil: (promise: Promise<any>) => void
) {
    console.log("[ALBUM] Received /canonize-album command");
    
    // Optional check: You can verify the user's admin status here if you aren't using Discord's default_member_permissions
    // const memberPermissions = BigInt(interaction.member?.permissions || "0");
    // const isAdmin = (memberPermissions & BigInt(0x8)) === BigInt(0x8);
    // if (!isAdmin) return new NextResponse('Unauthorized', { status: 403 });

    const options = interaction.data.options ??[];
    const targetSlugOpt = options.find(opt => opt.name === 'target-slug') as APIApplicationCommandInteractionDataStringOption | undefined;
    const canonSlugOpt = options.find(opt => opt.name === 'canon-slug') as APIApplicationCommandInteractionDataStringOption | undefined;

    if (!targetSlugOpt || !canonSlugOpt) {
         return new NextResponse('Missing required arguments', { status: 400 });
    }

    const targetSlug = targetSlugOpt.value;
    const canonSlug = canonSlugOpt.value;

    const runBackgroundTask = async () => {
        try {
            console.log(`[ALBUM] Attempting to canonize: ${targetSlug} -> ${canonSlug}`);
            const result = await canonizeAlbum(targetSlug, canonSlug);

            await editInteractionResponse(interaction.token, {
                content: result.success 
                    ? `🔗 **Success:** ${result.message}` 
                    : `❌ **Failed:** ${result.message}`
            });

        } catch (error) {
            console.error(`[ALBUM] FATAL error in canonize-album task:`, error);
            await editInteractionResponse(interaction.token, { 
                content: `❌ An internal error occurred while canonizing the album.` 
            });
        }
    };

    // Defer the interaction immediately, process in background
    waitUntil(runBackgroundTask());
    return NextResponse.json({ type: InteractionResponseType.DeferredChannelMessageWithSource });
}