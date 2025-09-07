// register-commands.js
// eslint-disable-next-line @typescript-eslint/no-require-imports
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
    name: 'countdown',
    description: 'Starts a 5-second countdown.',
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
    {
    name: 'rc',
    description: 'Raw Cover - displays the raw album art for a track or search.',
    options: [
      {
        name: 'search',
        description: 'Search for an album on Last.fm.',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'profile',
    description: 'Displays a Rate Your Music Profile from an RSS Feed File.',
    options: [
      {
        name: 'feed',
        description: 'The .txt or .xml file containing the RSS feed from Rate Your Music.',
        type: 11, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'chart',
    description: 'Generates a grid of your most listened to albums.',
    options: [
      {
        name: 'size',
        description: 'The dimensions of the chart grid (default: 3x3).',
        type: 3, // STRING
        required: false,
        choices: [
          { name: '3x3 (Default)', value: '3x3' },
          { name: '4x4', value: '4x4' },
          { name: '5x5', value: '5x5' },
          { name: '8x5', value: '8x5' },
          { name: '10x10', value: '10x10' },
          { name: '4x8', value: '4x8' },
          { name: '15x6', value: '15x6' },
        ]
      },
      {
        name: 'period',
        description: 'The time period for the chart (default: 7day).',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'Last 7 Days', value: '7day' },
          { name: '1 Month', value: '1month' },
          { name: '3 Months', value: '3month' },
          { name: '6 Months', value: '6month' },
          { name: '1 Year', value: '12month' },
          { name: 'Overall', value: 'overall' },
        ]
      },
      {
        name: 'user',
        description: 'The Last.fm username to generate the chart for.',
        type: 3, // STRING
        required: false
      },
      {
        name: 'labelling',
        description: 'How to display album names (default: No Names).',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'No Names (Default)', value: 'no_names' },
          { name: 'Topster Style', value: 'topster' },
          { name: 'Names Under Albums', value: 'under' },
        ],
      },
    ]
  },
  {
    name: 'league',
    description: "Finds tracks in a Spotify playlist that are by the server's top artists.",
    options: [
      {
        name: 'playlist',
        description: 'The full URL of the Spotify playlist.',
        type: 3, // STRING
        required: true,
      },
    ]
  },
  // --- NEW COMMAND ADDED HERE ---
  {
    name: 'serverchart',
    description: 'Generates a grid of the most listened to albums for the entire server.',
    options: [
      {
        name: 'size',
        description: 'The dimensions of the chart grid (default: 3x3).',
        type: 3, // STRING
        required: false,
        choices: [
          { name: '3x3 (Default)', value: '3x3' },
          { name: '4x4', value: '4x4' },
          { name: '5x5', value: '5x5' },
          { name: '8x5', value: '8x5' },
          { name: '10x10', value: '10x10' },
          { name: '4x8', value: '4x8' },
          { name: '15x6', value: '15x6' },
        ]
      },
      {
        name: 'period',
        description: 'The time period for the chart (default: 7day).',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'Last 7 Days', value: '7day' },
          { name: '1 Month', value: '1month' },
          { name: '3 Months', value: '3month' },
          { name: '6 Months', value: '6month' },
          { name: '1 Year', value: '12month' },
          { name: 'Overall', value: 'overall' },
        ]
      },
      {
        name: 'labelling',
        description: 'How to display album names (default: No Names).',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'No Names (Default)', value: 'no_names' },
          { name: 'Topster Style', value: 'topster' },
          { name: 'Names Under Albums', value: 'under' },
        ],
      },
    ]
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