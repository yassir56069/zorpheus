// register-commands.js
require('dotenv').config({ path: '.env.local' });

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token || !applicationId) {
  throw new Error('Please define DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID in your .env.local file');
}

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong! to test latency.',
  },
    {
    name: 'register',
    description: 'Register your Last.fm username with the bot.',
    options: [
      {
        name: 'username',
        description: 'Your Last.fm username.',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'cover',
    description: 'Fetches the album cover for your currently playing song on Last.fm.',
    options: [
      {
        name: 'search',
        description: 'Album to search for. Defaults to your currently playing song.',
        type: 3, // Type 3 corresponds to STRING
        required: false,
      },
    ],
  },
];

const url = `https://discord.com/api/v10/applications/${applicationId}/commands`;

const headers = {
  "Authorization": `Bot ${token}`,
  "Content-Type": "application/json",
};

fetch(url, {
  method: 'PUT',
  headers: headers,
  body: JSON.stringify(commands),
})
  .then(response => response.json())
  .then(data => {
    console.log('Successfully registered commands:', data);
  })
  .catch(console.error);