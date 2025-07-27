// utils/verify-discord-request.ts
import { verifyKey } from 'discord-interactions';

export async function verifyDiscordRequest(req: Request, publicKey: string) {
  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');
  const body = await req.text(); // Read body as text

  if (!signature || !timestamp || !body) {
    return { isValid: false, interaction: null };
  }

  const isValid = verifyKey(body, signature, timestamp, publicKey);

  return {
    isValid,
    interaction: await isValid ? JSON.parse(body) : null,
  };
}