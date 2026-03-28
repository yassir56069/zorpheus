// register-commands.js
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' });

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token || !applicationId) {
  throw new Error('Please define DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID in your .env.local file');
}

const commands = [

  //#region Admin: Canonize albums
  {
    "name": "canonize-album",
    "description": "[Admin] Link a duplicate album slug to the main canonical slug.",
    "default_member_permissions": "8", 
    "options":[
      {
        "name": "target-slug",
        "description": "The duplicate slug that should be hidden/merged.",
        "type": 3,
        "required": true
      },
      {
        "name": "canon-slug",
        "description": "The main canonical slug to link it to.",
        "type": 3,
        "required": true
      }
    ]
  },
  //#endregion

    //#region Admin: Canonize albums by id
  {
    "name": "canonize-album-id",
    "description": "Link a duplicate album slug to the main canonical slug. Use with caution.. please!",
    "options":[
      {
        "name": "target-id",
        "description": "This should be the target (the incorrect album)",
        "type": 3,
        "required": true
      },
      {
        "name": "canon-id",
        "description": "This should be the canon album (priorize ones with year, and with ratings! ).",
        "type": 3,
        "required": true
      }
    ]
  },
  //#endregion

  //#region 
  {
    "name": "aotd",
    "description": "[Admin] retrieves a random album within the top 30 and marks it as highlighted. ",
    "default_member_permissions": "8", 
  },
  //#endregion

  //#region Ping
  {
    name: 'ping',
    description: 'Replies with Pong! to test latency.',
  },
  //#endregion

  //#region Fm
  {
    name: 'fm',
    description: 'Displays your current scrobbled track.',
    options: [
      {
        name: 'username',
        description: 'A specific Last.fm username to look up.',
        type: 3, // STRING
        required: false,
      },
      {
        name: 'youtube_scrobble',
        description: "Applies a fix for scrobbles from YouTube 'Topic' channels. (Default: On)",
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
  //#endregion

  //#region Album Search
  {
    name: 'album-search',
    description: ' 🔎 search for an album on the bot\'s database',
    options: [
      {
        name: 'searchterm',
        description: 'Try the album name, or the artist name and album name!',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  //#endregion

  //#region Album 
  {
    name: 'album',
    description: 'Retrieve an album by it\'s slug',
    options: [
      {
        name: 'slug-value',
        description: 'Exact slug format (artistname-albumname-year). No spaces. Try /album-search if unsure.',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  //#endregion

  //#region Artist Search
    {
      name: 'artist-search',
      description: '🎭 search for an artist to view their discography',
      options:[
        {
          name: 'searchterm',
          description: 'Try the exact or partial name of the artist.',
          type: 3, // STRING
          required: true,
        },
      ],
    },
    //#endregion

  //#region Top Albums 
  {
    "name": "top-albums",
    "description": "View the top-rated albums on the server",
    "options": [
      {
        "type": 4,
        "name": "page",
        "description": "The page number to view",
        "required": false
      },
      {
        "type": 3,
        "name": "period",
        "description": "Filter by time period",
        "required": false,
        "choices": [
          { "name": "Last 7 Days", "value": "week" },
          { "name": "Last 30 Days", "value": "month" },
          { "name": "Last Year", "value": "year" }
        ]
      },
      {
        "name": "genre",
        "description": "pass a genre name to generate a genre chart instead.",
        "type": 3, 
        "required": false
      }
    ]
  },
  //#endregion

  //#region Donor Albums 
  {
    "name": "donor-albums",
    "description": "View albums that are missing a few ratings to be ranked.",
    "options": [
      {
        "type": 4,
        "name": "page",
        "description": "The page number to view",
        "required": false
      },
      {
        "type": 3,
        "name": "period",
        "description": "Filter by time period",
        "required": false,
        "choices": [
          { "name": "Last 7 Days", "value": "week" },
          { "name": "Last 30 Days", "value": "month" },
          { "name": "Last Year", "value": "year" }
        ]
      },
      {
        "name": "genre",
        "description": "pass a genre name to generate a genre chart instead.",
        "type": 3, 
        "required": false
      }
    ]
  },
  //#endregion

  //#region Join
  {
    name: 'join',
    description: 'Create your profile to use the bot, log Last.fm/RYM, and rate albums!',
    options: [
      {
        name: 'lastfm_username',
        description: 'Your Last.fm username (required).',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'rym_username',
        description: 'Your Rate Your Music username (optional).',
        type: 3, // STRING
        required: false,
      },
      {
        name: 'display_name',
        description: 'A custom name to show on your embeds (defaults to your Discord name).',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  //#endregion

  //#region Cover
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
      {
        name: 'youtube_scrobble',
        description: "Applies a fix for scrobbles from YouTube 'Topic' channels. (Default: On)",
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
  //#endregion

  //#region rc
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
  //#endregion

  //#region Rate
  {
      name: 'rate',
      description: 'Rate the album you are currently listening to (or specify a score).',
      options: [
          {
              name: 'stars',
              description: 'The rating (1-5 stars, 0.5 increments).',
              type: 10, // NUMBER
              required: false,
              choices: [
                { name: '[5.0] ★★★★★', value: 10},
                { name: '[4.5] ★★★★½', value: 9 },
                { name: '[4.0] ★★★★', value: 8},
                { name: '[3.5] ★★★½', value: 7 },
                { name: '[3.0] ★★★', value: 6},
                { name: '[2.5] ★★½', value: 5 },
                { name: '[2.0] ★★', value: 4},
                { name: '[1.5] ★½', value: 3 },
                { name: '[1.0] ★', value: 2 },
                { name: '[0.5] ½', value: 1 },
              ]
          }
      ]
  },
  //#endregion,

//#region Assign Genre
  {
    "name": "assign-genre",
    "description": "Manually tag an album with a genre from the database.",
    "options":[
      {
        "name": "album-id",
        "description": "The ID of the album (found at the bottom of the /album embed).",
        "type": 3, 
        "required": false
      }
    ]
  },
  //#endregion,

  //#region Import
  {
    "name": "import",
    "description": "Import your RateYourMusic CSV ratings data",
    "options": [
      {
        "name": "file",
        "description": "Upload your RYM .csv export",
        "type": 11,
        "required": true
      }
    ]
  },

  //#endregion

  //#region Chart
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
      {
        name: 'filter_remastered_deluxe',
        description: 'Combine remastered and deluxe versions into the original album (Default: True).',
        type: 5, // BOOLEAN
        required: false,
      },
      {
        name: 'filter_greys',
        description: 'Filter out albums that have no cover art (Default: True).',
        type: 5, // BOOLEAN
        required: false,
      }
    ]
  },
  //#endregion

  //#region Rated Chart
  {
    "name": "top-chart",
    "description": "Generates a grid of the highest rated albums in the server.",
    "options": [
      {
        "name": "size",
        "description": "The dimensions of the chart grid (default: 3x3).",
        "type": 3, 
        "required": false,
        "choices": [
          { name: '3x3', value: '3x3' },
          { name: '4x4', value: '4x4' },
          { name: '5x5 (default)', value: '5x5' },
          { name: '8x5', value: '8x5' },
          { name: '10x10', value: '10x10' },
          { name: '4x8', value: '4x8' },
          { name: '15x6', value: '15x6' },
        ]
      },
      {
        "name": "period",
        "description": "Filter by ratings from a specific time period.",
        "type": 3,
        "required": false,
        "choices": [
          { "name": "Last 7 Days", "value": "week" },
          { "name": "Last Month", "value": "month" },
          { "name": "Last Year", "value": "year" },
          { "name": "All Time", "value": "overall" }
        ]
      },
      {
        "name": "page",
        "description": "Which page of the rankings to display (default: 1).",
        "type": 4, 
        "required": false
      },
      {
        "name": "genre",
        "description": "pass a genre name to generate a genre chart instead.",
        "type": 3, 
        "required": false
      }
    ]
  },
  //#endregion

  //#region Profile
  {
    name: 'profile',
    description: 'Displays your profile on Zorpheus 🦇🩸.',
  },
  //#endregion

  //#region User Ratings Search
  {
    name: 'user-ratings',
    description: '🔎 Search for a specific album among a user\'s ratings',
    options:[
      {
        name: 'searchterm',
        description: 'Try the exact or partial name of the artist or album.',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'user',
        description: 'The user to search the ratings of (defaults to you).',
        type: 6, // USER
        required: false,
      }
    ]
  },
  //#endregion

  //#region Server Chart (TO BE REWORKED!)
  // {
  //   name: 'serverchart',
  //   description: 'Generates a grid of the most listened to albums for the entire server.',
  //   options: [
  //     {
  //       name: 'size',
  //       description: 'The dimensions of the chart grid (default: 3x3).',
  //       type: 3, // STRING
  //       required: false,
  //       choices: [
  //         { name: '3x3 (Default)', value: '3x3' },
  //         { name: '4x4', value: '4x4' },
  //         { name: '5x5', value: '5x5' },
  //         { name: '8x5', value: '8x5' },
  //         { name: '10x10', value: '10x10' },
  //         { name: '4x8', value: '4x8' },
  //         { name: '15x6', value: '15x6' },
  //       ]
  //     },
  //     {
  //       name: 'period',
  //       description: 'The time period for the chart (default: 7day).',
  //       type: 3, // STRING
  //       required: false,
  //       choices: [
  //         { name: 'Last 7 Days', value: '7day' },
  //         { name: '1 Month', value: '1month' },
  //         { name: '3 Months', value: '3month' },
  //         { name: '6 Months', value: '6month' },
  //         { name: '1 Year', value: '12month' },
  //         { name: 'Overall', value: 'overall' },
  //       ]
  //     },
  //     {
  //       name: 'labelling',
  //       description: 'How to display album names (default: No Names).',
  //       type: 3, // STRING
  //       required: false,
  //       choices: [
  //         { name: 'No Names (Default)', value: 'no_names' },
  //         { name: 'Topster Style', value: 'topster' },
  //         { name: 'Names Under Albums', value: 'under' },
  //       ],
  //     },
  //     {
  //       name: 'filter_remastered',
  //       description: 'Combine remastered versions into the original album (Default: True).',
  //       type: 5, // BOOLEAN
  //       required: false,
  //     },
  //     {
  //       name: 'filter_greys',
  //       description: 'Filter out albums that have no cover art (Default: True).',
  //       type: 5, // BOOLEAN
  //       required: false,
  //     }
  //   ]
  // },

  //#endregion

  //#region  DEPRECATED / UNUSED
  {
    name: 'league',
    description: "Server artist league commands.",
    options: [
      {
        name: 'find',
        description: "Finds tracks in a Spotify playlist by the server's top artists.",
        type: 1, // This type indicates a SUB_COMMAND
        options: [
          {
            name: 'playlist',
            description: 'The full URL of the Spotify playlist.',
            type: 3, // STRING
            required: true,
          },
        ]
      },
      {
        name: 'banned',
        description: "Displays the top 30 'banned' artists for the server league.",
        type: 1, // This type indicates a SUB_COMMAND
      }
    ]
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
  //#endregion
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