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
    name: 'fm',
    description: '[in beta] displays your current scrobbled track',
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
    "name": "dev",
    "description": "Developer-only commands for testing.",
    "options": [
        {
        "name": "key",
        "description": "The specific developer command to run",
        "type": 3, // String type
        "required": true
        },
        {
        "name": "value",
        "description": "Optional value for the test command.",
        "type": 3, // String type
        "required": false
        }
    ]
    },
  {
    name: 'cover',
    description: 'Displays album art. Searches for an album or shows your last played track.',
    options: [
      {
        name: 'search',
        description: 'search for an album on last.fm.',
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