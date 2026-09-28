#!/usr/bin/env node
/**
 * Smartist — Dev database seeder
 *
 * Populates the database with realistic test data:
 *   - ~50 songs (various genres, keys, tempos, originals with lyrics, covers with links)
 *   - 30 venues across Europe
 *   - 30 organizers (agencies, festivals, clubs, associations)
 *   - 30 gigs (past + upcoming) linked to venues and organizers
 *   - 30 setlists linked to gigs + standalone templates
 *   - Song audit log entries
 *   - 2 GEMA works with rightholders
 *
 * Usage:
 *   node scripts/seed.js                  # seed (skips if data exists)
 *   node scripts/seed.js --force          # wipe and reseed
 *   DATABASE_URL=<url> node scripts/seed.js
 *
 * Reads DATABASE_URL and ARTIST_SLUG from .env / .env.local in the project root.
 * Targets the artist matching ARTIST_SLUG (falls back to the first artist in the DB).
 */

'use strict';

const lib        = require('./_lib');

lib.loadEnv();

// ── Print helpers ──────────────────────────────────────────────────────────

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const ok   = msg => console.log(`  ${G('✓')} ${msg}`);
const warn = msg => console.log(`  ${Y('!')} ${msg}`);
const err  = msg => console.log(`  ${R('✗')} ${msg}`);

// ── Args ───────────────────────────────────────────────────────────────────

const FORCE = process.argv.includes('--force');

// ── DB ─────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  err('DATABASE_URL is not set. Add it to .env or pass it as an environment variable.');
  process.exit(1);
}

const sql = lib.connect(DATABASE_URL);

// ── Seed data ──────────────────────────────────────────────────────────────

const SONGS = [
  // ── Originals ─────────────────────────────────────────────────────────────
  {
    title: 'Midnight Drive', active: true, key: 'D', genre: 'Rock', energy: 8,
    length_min: 3.75, interpret: null, time_signature: '4/4',
    comment: 'Our opener — high energy start',
    extra: {
      listenUrl: 'https://soundcloud.com/example/midnight-drive',
      lyrics: `[Verse 1]
Engine turning, headlights burning
Down the empty midnight road
Left the town behind me yearning
Dropped every heavy load

[Chorus]
Midnight drive, feel alive
Nothing left to hide
Midnight drive, gonna survive
Rolling with the tide

[Verse 2]
Stars above me, road below me
Miles to go before the dawn
Something tells me where I'm going
Something pulls me on and on

[Bridge]
Don't look back, don't look back
Only forward, only free
Don't look back, don't look back
This road was made for me`,
    },
  },
  {
    title: 'River Town Blues', active: true, key: 'E', genre: 'Blues', energy: 5,
    length_min: 4.25, interpret: null,
    comment: 'B.B. King-style, key may drop to Eb live',
    extra: {
      listenUrl: 'https://soundcloud.com/example/river-town-blues',
      lyrics: `[Verse 1]
Sitting by the river, watching water roll
Got a kind of emptiness that swallows up my soul
People in this river town, they pass me every day
Nobody stops to listen to a word I have to say

[Chorus]
River town blues, got nowhere to go
River town blues, got nothing to show
The river keeps on rolling, rolling to the sea
And all I've got to keep me is this old melody

[Verse 2]
Grandma said this river town was built on solid ground
But the ground beneath my feet ain't making any sound
Every boat that passes leaves a wake upon the shore
And I keep on waiting for something more`,
    },
  },
  {
    title: 'Morning Light', active: true, key: 'G', genre: 'Folk', energy: 2,
    length_min: 3.5, interpret: null,
    extra: {
      lyrics: `[Verse 1]
Woke up to the morning light
Shadows dancing on the wall
Yesterday has gone with the night
And I'm standing ten feet tall

[Chorus]
Morning light, morning light
Everything is gonna be alright
Morning light, shine on me
Set this troubled spirit free

[Verse 2]
Coffee warm and window cold
Frost on every pane of glass
Stories waiting to be told
About a life that moves too fast

[Outro]
Let the morning light in
Let the morning light in`,
    },
  },
  {
    title: 'Broken Strings', active: true, key: 'Am', genre: 'Blues', energy: 2,
    length_min: 4.0, interpret: null,
    extra: {
      lyrics: `[Verse 1]
Been playing this old guitar
Since the day that you left town
Every note rings like a scar
Every tune brings me down

[Chorus]
Broken strings, broken things
That's what a leaving lover brings
Broken strings on a worn-out neck
All that's left of this wreck

[Verse 2]
The sound hole swallows up my words
The tuning pegs are stripped and bare
My playing doesn't reach the birds
Just hangs alone in empty air

[Solo section]
(guitar solo)

[Outro]
Broken strings... broken strings...`,
    },
  },
  {
    title: 'Last Train South', active: true, key: 'A', genre: 'Country', energy: 5,
    length_min: 3.75, interpret: null,
    extra: {
      capo: 2,
      lyrics: `[Verse 1]
Bought a one-way ticket down
At the station past midnight
Left this cold and rainy town
With nothing but the clothes on my back

[Chorus]
Last train south, hear her blow
Taking me where the warm winds blow
Last train south, rolling free
Gonna find out who I'm meant to be

[Verse 2]
Conductor punched my crumpled card
Said boy you're going quite a way
I said I know it's gonna be hard
But I can't stand another grey day

[Bridge]
Fields are rolling past the glass
Towns I've never seen before
All the things I thought would last
Are gone — I'm not keeping score`,
    },
  },
  {
    title: 'Smoke and Mirrors', active: true, key: 'Dm', genre: 'Rock', energy: 8,
    length_min: 3.5, interpret: null,
    extra: {
      lyrics: `[Verse 1]
You sold me dreams like a street magician
Dressed up promises in gold
Everything went right on your commission
Until the whole story got too old

[Pre-chorus]
Now I see the wires
Now I see the game

[Chorus]
Smoke and mirrors, smoke and mirrors
That's the only thing you know
Smoke and mirrors, smoke and mirrors
Watch it all disappear in the show

[Verse 2]
The audience is leaving one by one
The curtain's fraying at the seams
Turns out the magic was never done
Just me believing in your schemes`,
    },
  },
  {
    title: 'The Wanderer', active: true, key: 'C', genre: 'Folk', energy: 5,
    length_min: 4.0, interpret: null,
    extra: {
      capo: 0,
      lyrics: `[Verse 1]
I've been down a hundred roads
Carried a hundred different loads
Every town a different face
Every bar a different place

[Chorus]
This is the wanderer's song
I've been away so long
Home is where the music plays
These are the wanderer's days

[Verse 2]
I've slept in barns and back seat cars
Watched the highway stars go by
Every stranger shares their stories
And every morning is a new sky

[Bridge]
They say a rolling stone gathers no moss
But I've gathered miles and songs and nights
Every road I've crossed a different boss
Every dawn a different set of lights`,
    },
  },
  {
    title: 'Empty Room', active: true, key: 'E', genre: 'Blues', energy: 2,
    length_min: 5.0, interpret: null,
    extra: {
      lyrics: `[Verse 1]
Come home to an empty room
Your chair still at the table
The whole house smells like perfume
And a half-written fable

[Chorus]
Empty room, empty walls
Empty hallway, empty halls
Empty room echoes back
Every single thing I lack

[Verse 2]
Your records on the shelf up there
I can't bring myself to play them
Your coat still hanging by the stair
I can't bring myself to move them

[Guitar break]

[Verse 3]
Maybe someday I'll pack this up
Maybe someday I'll move along
But tonight I'll drink this cup
And sing this empty room song`,
    },
  },
  // ── Covers — Rock / Classic ────────────────────────────────────────────────
  {
    title: 'Highway Star', active: true, key: 'G', genre: 'Rock', energy: 8,
    length_min: 4.5, interpret: 'Deep Purple',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=aGgGhXP2KQk',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Highway_Star_(song)',
    },
  },
  {
    title: 'Whole Lotta Love', active: true, key: 'E', genre: 'Rock', energy: 8,
    length_min: 5.5, interpret: 'Led Zeppelin',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=HQmmM_qwG4k',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Whole_Lotta_Love',
    },
  },
  {
    title: 'Come Together', active: true, key: 'Dm', genre: 'Rock', energy: 5,
    length_min: 4.2, interpret: 'The Beatles',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=45cYwDMibGo',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Come_Together',
    },
  },
  {
    title: 'La Grange', active: true, key: 'E', genre: 'Blues Rock', energy: 8,
    length_min: 5.5, interpret: 'ZZ Top',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=JBL9h7XTQUU',
      songinfoUrl: 'https://en.wikipedia.org/wiki/La_Grange_(ZZ_Top_song)',
    },
  },
  {
    title: 'Little Wing', active: true, key: 'Em', genre: 'Rock', energy: 2,
    length_min: 2.5, interpret: 'Jimi Hendrix',
    comment: 'Slow intro, build up gradually',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=pNzHxDHQgCk',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Little_Wing',
    },
  },
  {
    title: 'All Along the Watchtower', active: true, key: 'Am', genre: 'Rock', energy: 5,
    length_min: 4.0, interpret: 'Bob Dylan', reference_interpret: 'Jimi Hendrix',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=TLV4_xaYynY',
      songinfoUrl: 'https://en.wikipedia.org/wiki/All_Along_the_Watchtower',
    },
  },
  {
    title: 'Hotel California', active: true, key: 'Bm', genre: 'Rock', energy: 5,
    length_min: 6.5, interpret: 'Eagles',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=BciS5krYL80',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Hotel_California_(Eagles_song)',
    },
  },
  {
    title: 'Knockin\' on Heaven\'s Door', active: true, key: 'G', genre: 'Folk Rock', energy: 2,
    length_min: 2.75, interpret: 'Bob Dylan',
    extra: {
      capo: 0,
      listenUrl: 'https://www.youtube.com/watch?v=BhcqlBMxCz0',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Knockin%27_on_Heaven%27s_Door',
    },
  },
  {
    title: 'Blowin\' in the Wind', active: true, key: 'G', genre: 'Folk', energy: 2,
    length_min: 2.75, interpret: 'Bob Dylan',
    extra: {
      capo: 2,
      listenUrl: 'https://www.youtube.com/watch?v=vWwgrjjIMXA',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Blowin%27_in_the_Wind',
    },
  },
  // ── Covers — Blues ────────────────────────────────────────────────────────
  {
    title: 'Crossroads', active: true, key: 'A', genre: 'Blues', energy: 8,
    length_min: 3.75, interpret: 'Robert Johnson', reference_interpret: 'Cream',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=MFpO2AJI9mk',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Cross_Road_Blues',
    },
  },
  {
    title: 'The Thrill Is Gone', active: true, key: 'Bm', genre: 'Blues', energy: 2,
    length_min: 5.0, interpret: 'B.B. King',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=oica5jG7FpU',
      songinfoUrl: 'https://en.wikipedia.org/wiki/The_Thrill_Is_Gone',
    },
  },
  {
    title: 'Pride and Joy', active: true, key: 'E', genre: 'Blues', energy: 5,
    length_min: 3.5, interpret: 'Stevie Ray Vaughan',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=pB3hFoEULHU',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Pride_and_Joy_(Stevie_Ray_Vaughan_song)',
    },
  },
  {
    title: 'Born Under a Bad Sign', active: true, key: 'C#m', genre: 'Blues', energy: 5,
    length_min: 3.25, interpret: 'Albert King',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=5JlXHxS5lho',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Born_Under_a_Bad_Sign',
    },
  },
  {
    title: 'Ain\'t No Sunshine', active: true, key: 'Am', genre: 'Soul', energy: 2,
    length_min: 2.1, interpret: 'Bill Withers',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=CICIOJqEb5c',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Ain%27t_No_Sunshine',
    },
  },
  // ── Covers — Folk / Country ───────────────────────────────────────────────
  {
    title: 'Wagon Wheel', active: true, key: 'A', genre: 'Country', energy: 5,
    length_min: 4.0, interpret: 'Old Crow Medicine Show',
    extra: {
      capo: 2,
      listenUrl: 'https://www.youtube.com/watch?v=9SJ5RopHLsE',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Wagon_Wheel_(song)',
    },
  },
  {
    title: 'Take Me Home, Country Roads', active: true, key: 'G', genre: 'Country', energy: 5,
    length_min: 3.25, interpret: 'John Denver',
    extra: {
      capo: 0,
      listenUrl: 'https://www.youtube.com/watch?v=1vrEljMfXYo',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Take_Me_Home,_Country_Roads',
    },
  },
  {
    title: 'The House of the Rising Sun', active: true, key: 'Am', genre: 'Folk', energy: 2,
    length_min: 4.5, interpret: 'The Animals',
    extra: {
      capo: 0,
      listenUrl: 'https://www.youtube.com/watch?v=liZkHQmDIFQ',
      songinfoUrl: 'https://en.wikipedia.org/wiki/The_House_of_the_Rising_Sun',
    },
  },
  {
    title: 'Old Man', active: true, key: 'D', genre: 'Folk', energy: 5,
    length_min: 3.5, interpret: 'Neil Young',
    extra: {
      capo: 5,
      listenUrl: 'https://www.youtube.com/watch?v=An8oH3M-Leo',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Old_Man_(Neil_Young_song)',
    },
  },
  {
    title: 'The Weight', active: true, key: 'A', genre: 'Folk Rock', energy: 5,
    length_min: 5.0, interpret: 'The Band',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=FFqb1I-hiHE',
      songinfoUrl: 'https://en.wikipedia.org/wiki/The_Weight_(song)',
    },
  },
  {
    title: 'Fields of Gold', active: true, key: 'Bm', genre: 'Pop', energy: 2,
    length_min: 3.75, interpret: 'Sting',
    extra: {
      capo: 2,
      listenUrl: 'https://www.youtube.com/watch?v=fCaDs4Mf3jE',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Fields_of_Gold',
    },
  },
  // ── Covers — Funk / Soul ──────────────────────────────────────────────────
  {
    title: 'Superstition', active: true, key: 'Ebm', genre: 'Funk', energy: 5,
    length_min: 4.0, interpret: 'Stevie Wonder',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=0CFuCYNx-1g',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Superstition_(song)',
    },
  },
  {
    title: 'Signed, Sealed, Delivered', active: true, key: 'F', genre: 'Soul', energy: 5,
    length_min: 2.75, interpret: 'Stevie Wonder',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=WtKd0jCHaBs',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Signed,_Sealed,_Delivered_I%27m_Yours',
    },
  },
  {
    title: 'Respect', active: true, key: 'C', genre: 'Soul', energy: 5,
    length_min: 2.5, interpret: 'Aretha Franklin',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=6FOUqQt3Kg0',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Respect_(Otis_Redding_song)',
    },
  },
  {
    title: 'Mustang Sally', active: true, key: 'C', genre: 'Soul', energy: 5,
    length_min: 3.25, interpret: 'Wilson Pickett',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=7dS9A3CaXpE',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Mustang_Sally',
    },
  },
  {
    title: 'Georgia on My Mind', active: true, key: 'F', genre: 'Soul', energy: 2,
    length_min: 3.5, interpret: 'Ray Charles',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=Zl2DSPZjfO8',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Georgia_on_My_Mind',
    },
  },
  // ── Covers — Reggae ───────────────────────────────────────────────────────
  {
    title: 'No Woman, No Cry', active: true, key: 'C', genre: 'Reggae', energy: 2,
    length_min: 6.5, interpret: 'Bob Marley',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=nQ5R7kGVDSg',
      songinfoUrl: 'https://en.wikipedia.org/wiki/No_Woman,_No_Cry',
    },
  },
  {
    title: 'Redemption Song', active: true, key: 'G', genre: 'Reggae', energy: 2,
    length_min: 3.5, interpret: 'Bob Marley',
    extra: {
      capo: 2,
      listenUrl: 'https://www.youtube.com/watch?v=OHBfMFqIFZQ',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Redemption_Song',
    },
  },
  // ── Covers — Alternative / Indie ─────────────────────────────────────────
  {
    title: 'Creep', active: true, key: 'G', genre: 'Alternative', energy: 2,
    length_min: 3.75, interpret: 'Radiohead',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=XFkzRNyygfk',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Creep_(Radiohead_song)',
    },
  },
  {
    title: 'Mr. Jones', active: true, key: 'Am', genre: 'Alternative', energy: 5,
    length_min: 4.5, interpret: 'Counting Crows',
    extra: {
      capo: 5,
      listenUrl: 'https://www.youtube.com/watch?v=jhb9BjxJR8s',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Mr._Jones_(Counting_Crows_song)',
    },
  },
  {
    title: 'Roxanne', active: true, key: 'Am', genre: 'Rock', energy: 5,
    length_min: 3.25, interpret: 'The Police',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=3T1c7GkzRQQ',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Roxanne_(The_Police_song)',
    },
  },
  {
    title: 'With or Without You', active: true, key: 'D', genre: 'Rock', energy: 2,
    length_min: 4.75, interpret: 'U2',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=XmSdTa9kaiQ',
      songinfoUrl: 'https://en.wikipedia.org/wiki/With_or_Without_You',
    },
  },
  {
    title: 'Tears in Heaven', active: true, key: 'A', genre: 'Pop', energy: 2,
    length_min: 4.5, interpret: 'Eric Clapton',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=JOZBEGnl_G0',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Tears_in_Heaven',
    },
  },
  {
    title: 'Wonderful Tonight', active: true, key: 'G', genre: 'Rock', energy: 2,
    length_min: 3.75, interpret: 'Eric Clapton',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=F4XF3GHMeW4',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Wonderful_Tonight',
    },
  },
  {
    title: 'Stand By Me', active: true, key: 'A', genre: 'Soul', energy: 5,
    length_min: 3.0, interpret: 'Ben E. King',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=hwZNL7QVJjE',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Stand_by_Me_(Ben_E._King_song)',
    },
  },
  {
    title: 'Johnny B. Goode', active: true, key: 'Bb', genre: 'Rock', energy: 8,
    length_min: 2.75, interpret: 'Chuck Berry',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=ZgmGkCKiq2I',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Johnny_B._Goode',
    },
  },
  {
    title: 'Feeling Good', active: true, key: 'Dm', genre: 'Jazz', energy: 2,
    length_min: 3.0, interpret: 'Nina Simone',
    comment: 'Open with this on acoustic nights',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=oHs5pTt7V28',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Feeling_Good',
    },
  },
  // ── Inactive ──────────────────────────────────────────────────────────────
  {
    title: 'Brown Eyed Girl', active: false, key: 'G', genre: 'Rock', energy: 5,
    length_min: 3.5, interpret: 'Van Morrison',
    comment: 'Too overplayed — retired',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=UfMGSQjGGsc',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Brown_Eyed_Girl',
    },
  },
  {
    title: 'Sweet Home Chicago', active: false, key: 'E', genre: 'Blues', energy: 8,
    length_min: 3.0, interpret: 'Robert Johnson',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=v9Sl_p8FMkA',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Sweet_Home_Chicago',
    },
  },
  {
    title: 'Africa', active: false, key: 'Abm', genre: 'Pop', energy: 5,
    length_min: 4.5, interpret: 'Toto',
    comment: 'Dropped — doesn\'t fit the setlist vibe',
    extra: {
      listenUrl: 'https://www.youtube.com/watch?v=FTQbiNvZqaY',
      songinfoUrl: 'https://en.wikipedia.org/wiki/Africa_(Toto_song)',
    },
  },
];

const VENUES = [
  // France
  {
    name: 'Le Chat Noir', city: 'Lyon', country: 'France', postcode: '69001',
    state: 'Auvergne-Rhône-Alpes', size: 200, status: 'Active', category: 'club',
    website: 'https://lechatnoir.example.fr', booking_channel: 'Email',
    generic_email: 'booking@lechatnoir.example.fr',
    comment: 'Great outdoor courtyard. PA included. Contact: Julien Morel.',
    main_genre: 'Blues', turnus: 'Monthly',
  },
  {
    name: 'Parc des Expositions', city: 'Nantes', country: 'France', postcode: '44300',
    state: 'Pays de la Loire', size: 5000, status: 'Confirmed', category: 'festival',
    website: 'https://parcexpo-nantes.example.fr', booking_channel: 'Agency',
    comment: 'Festival site — large outdoor stage. Load-in from 14:00.',
    main_genre: 'Mixed', season: 'Summer',
  },
  {
    name: 'La Maison Bleue', city: 'Bordeaux', country: 'France', postcode: '33000',
    state: 'Nouvelle-Aquitaine', size: 350, status: 'Prospect', category: 'club',
    generic_email: 'contact@maisonbleue.example.fr', booking_channel: 'Email',
    comment: 'On our shortlist for the warm-up show. No response yet.',
    main_genre: 'Rock',
  },
  {
    name: 'Le Cargo', city: 'Rouen', country: 'France', postcode: '76000',
    state: 'Normandie', size: 500, status: 'Prospect', category: 'club',
    website: 'https://lecargo.example.fr', generic_email: 'prog@lecargo.example.fr',
    booking_channel: 'Email',
    comment: 'Alternative option for warm-up show. Known for indie/rock nights.',
    main_genre: 'Rock',
  },
  {
    name: 'Le Trabendo', city: 'Paris', country: 'France', postcode: '75019',
    state: 'Île-de-France', size: 700, status: 'Active', category: 'club',
    website: 'https://letrabendo.example.fr', generic_email: 'booking@letrabendo.example.fr',
    booking_channel: 'Agency', main_genre: 'Rock', turnus: 'Weekly',
    comment: 'Parc de la Villette. Great sound, professional crew.',
  },
  {
    name: 'L\'Épicerie Moderne', city: 'Feyzin', country: 'France', postcode: '69320',
    state: 'Auvergne-Rhône-Alpes', size: 800, status: 'Active', category: 'club',
    generic_email: 'contact@lepiceriemoderne.example.fr', booking_channel: 'Email',
    main_genre: 'Mixed', turnus: 'Monthly',
    comment: 'Converted warehouse, excellent acoustics.',
  },
  {
    name: 'La Ferronnerie', city: 'Toulouse', country: 'France', postcode: '31000',
    state: 'Occitanie', size: 180, status: 'Active', category: 'club',
    generic_email: 'prog@laferronnerie.example.fr', booking_channel: 'Email',
    main_genre: 'Blues', turnus: 'Bi-monthly',
    comment: 'Intimate blues venue. Bar is excellent.',
  },
  {
    name: 'La Cigale', city: 'Paris', country: 'France', postcode: '75018',
    state: 'Île-de-France', size: 1800, status: 'Prospect', category: 'club',
    website: 'https://lacigale.example.fr', booking_channel: 'Agency',
    main_genre: 'Mixed',
    comment: 'Dream venue. Need label backing to get in.',
  },
  {
    name: 'Salle Pleyel', city: 'Paris', country: 'France', postcode: '75008',
    state: 'Île-de-France', size: 2400, status: 'Prospect', category: 'club',
    website: 'https://sallepleyel.example.fr', booking_channel: 'Agency',
    main_genre: 'Classical / Crossover',
    comment: 'Ambitious long-term target. Acoustic nights series.',
  },
  {
    name: 'Le Chabada', city: 'Angers', country: 'France', postcode: '49000',
    state: 'Pays de la Loire', size: 600, status: 'Active', category: 'club',
    generic_email: 'prog@lechabada.example.fr', booking_channel: 'Email',
    main_genre: 'Mixed', turnus: 'Monthly',
  },
  {
    name: 'Le Brin de Zinc', city: 'Rennes', country: 'France', postcode: '35000',
    state: 'Bretagne', size: 120, status: 'Active', category: 'pub',
    generic_email: 'contact@brindezinc.example.fr', booking_channel: 'Direct',
    main_genre: 'Folk', turnus: 'Weekly',
    comment: 'Small but loyal crowd. Free-entry nights.',
  },
  {
    name: 'Le Moloco', city: 'Audincourt', country: 'France', postcode: '25400',
    state: 'Bourgogne-Franche-Comté', size: 700, status: 'Active', category: 'club',
    website: 'https://lemoloco.example.fr', booking_channel: 'Email',
    main_genre: 'Rock',
  },
  // Germany
  {
    name: 'Kulturzentrum am Schloss', city: 'Heidelberg', country: 'Germany',
    postcode: '69117', state: 'Baden-Württemberg', size: 280, status: 'Active', category: 'club',
    generic_email: 'buero@kuzas.example.de', booking_channel: 'Email',
    main_genre: 'Folk', turnus: 'Bi-monthly',
    comment: 'Reliable venue, good sound system. Audience is very attentive.',
  },
  {
    name: 'Bi Nuu', city: 'Berlin', country: 'Germany', postcode: '10997',
    state: 'Berlin', size: 600, status: 'Active', category: 'club',
    website: 'https://binuu.example.de', booking_channel: 'Email',
    main_genre: 'Rock', turnus: 'Weekly',
    comment: 'Under the U-Bahn arches. Loud but great atmosphere.',
  },
  {
    name: 'Fabrik', city: 'Hamburg', country: 'Germany', postcode: '22767',
    state: 'Hamburg', size: 1200, status: 'Prospect', category: 'club',
    website: 'https://fabrik.example.de', booking_channel: 'Agency',
    main_genre: 'Mixed',
  },
  {
    name: 'Strom', city: 'Munich', country: 'Germany', postcode: '80337',
    state: 'Bavaria', size: 400, status: 'Active', category: 'club',
    generic_email: 'booking@strom.example.de', booking_channel: 'Email',
    main_genre: 'Indie / Blues',
    comment: 'Good sound, friendly promoter.',
  },
  {
    name: 'Hirsch', city: 'Nuremberg', country: 'Germany', postcode: '90429',
    state: 'Bavaria', size: 500, status: 'Active', category: 'club',
    website: 'https://hirsch.example.de', booking_channel: 'Email',
    main_genre: 'Rock', turnus: 'Monthly',
  },
  {
    name: 'Lofft', city: 'Leipzig', country: 'Germany', postcode: '04109',
    state: 'Saxony', size: 300, status: 'Prospect', category: 'club',
    booking_channel: 'Email', main_genre: 'Mixed',
  },
  {
    name: 'Substage', city: 'Karlsruhe', country: 'Germany', postcode: '76133',
    state: 'Baden-Württemberg', size: 900, status: 'Active', category: 'club',
    website: 'https://substage.example.de', booking_channel: 'Agency',
    main_genre: 'Rock', turnus: 'Weekly',
  },
  // Belgium / Netherlands
  {
    name: 'Ancienne Belgique', city: 'Brussels', country: 'Belgium', postcode: '1000',
    size: 2000, status: 'Prospect', category: 'club',
    website: 'https://ab.example.be', booking_channel: 'Agency',
    main_genre: 'Mixed',
    comment: 'Prestige venue for Benelux market.',
  },
  {
    name: 'Café Central', city: 'Brussels', country: 'Belgium', postcode: '1000',
    size: 250, status: 'Active', category: 'club',
    generic_email: 'booking@cafecentral.example.be', booking_channel: 'Email',
    main_genre: 'Jazz / Blues', turnus: 'Weekly',
    comment: 'Jazz and blues focused. Seated shows.',
  },
  {
    name: 'Paradiso', city: 'Amsterdam', country: 'Netherlands', postcode: '1017',
    size: 1500, status: 'Prospect', category: 'club',
    website: 'https://paradiso.example.nl', booking_channel: 'Agency',
    main_genre: 'Mixed',
  },
  {
    name: 'De Helling', city: 'Utrecht', country: 'Netherlands', postcode: '3511',
    size: 700, status: 'Active', category: 'club',
    generic_email: 'booking@dehelling.example.nl', booking_channel: 'Email',
    main_genre: 'Rock',
  },
  // Switzerland / Austria
  {
    name: 'Papiersaal', city: 'Zurich', country: 'Switzerland', postcode: '8005',
    size: 350, status: 'Active', category: 'club',
    generic_email: 'events@papiersaal.example.ch', booking_channel: 'Email',
    main_genre: 'Mixed', turnus: 'Monthly',
    comment: 'Beautiful converted paper mill.',
  },
  {
    name: 'Turnhalle', city: 'Basel', country: 'Switzerland', postcode: '4057',
    size: 450, status: 'Prospect', category: 'club',
    booking_channel: 'Email', main_genre: 'Rock',
  },
  {
    name: 'WUK', city: 'Vienna', country: 'Austria', postcode: '1090',
    size: 800, status: 'Active', category: 'club',
    website: 'https://wuk.example.at', booking_channel: 'Email',
    main_genre: 'Mixed', turnus: 'Monthly',
    comment: 'Cultural centre, very diverse programme.',
  },
  // Spain / UK
  {
    name: 'Sala Razzmatazz', city: 'Barcelona', country: 'Spain', postcode: '08005',
    size: 2000, status: 'Prospect', category: 'club',
    website: 'https://razzmatazz.example.es', booking_channel: 'Agency',
    main_genre: 'Mixed',
  },
  {
    name: 'The Borderline', city: 'London', country: 'United Kingdom', postcode: 'W1F 9HX',
    size: 275, status: 'Prospect', category: 'club',
    booking_channel: 'Agency', main_genre: 'Rock / Blues',
    comment: 'UK market entry target.',
  },
  {
    name: 'Espace Aragon', city: 'Strasbourg', country: 'France', postcode: '67000',
    state: 'Grand Est', size: 500, status: 'Active', category: 'club',
    generic_email: 'prog@espacearagon.example.fr', booking_channel: 'Email',
    main_genre: 'Mixed', turnus: 'Monthly',
  },
  {
    name: 'Stereolux', city: 'Nantes', country: 'France', postcode: '44200',
    state: 'Pays de la Loire', size: 900, status: 'Active', category: 'club',
    website: 'https://stereolux.example.fr', booking_channel: 'Email',
    main_genre: 'Electronic / Rock',
  },
];

const ORGANIZERS = [
  {
    name: 'Jazz & Blues Prod', type: 'Agency',
    email: 'booking@jazzblues.example.fr', phone: '+33 1 23 45 67 89',
    website: 'https://jazzblues-prod.example.fr', city: 'Paris', country: 'France',
    comment: 'Main booking agency. Contact: Marie Leclerc. Responsive, good network.',
  },
  {
    name: 'Festival du Bout du Monde', type: 'Festival',
    email: 'artists@fest-bdm.example.org', city: 'Quimper', country: 'France',
    comment: 'Annual festival in Brittany. Very professional. 2-year advance planning.',
  },
  {
    name: 'Self-organized', type: 'Self',
    city: null, country: null,
    comment: 'Direct booking — no external organizer involved.',
  },
  {
    name: 'Rhône Blues Collective', type: 'Association',
    email: 'contact@rhoneblues.example.fr', city: 'Lyon', country: 'France',
    comment: 'Non-profit blues collective. Pay is low but audience is dedicated.',
  },
  {
    name: 'Bonne Étoile Concerts', type: 'Agency',
    email: 'info@bonneetoile.example.fr', phone: '+33 4 56 78 90 12',
    city: 'Marseille', country: 'France',
    comment: 'Southern France specialist. Good for summer tours.',
  },
  {
    name: 'Nord Live', type: 'Promoter',
    email: 'prog@nordlive.example.fr', city: 'Lille', country: 'France',
    comment: 'Active in the Nord-Pas-de-Calais region.',
  },
  {
    name: 'Kultur Büro Rhein', type: 'Agency',
    email: 'booking@kulturburo.example.de', phone: '+49 221 123 456',
    city: 'Cologne', country: 'Germany',
    comment: 'Best German contact. Books the whole Rhineland circuit.',
  },
  {
    name: 'Blues im Keller', type: 'Club',
    email: 'info@bluesimkeller.example.de', city: 'Stuttgart', country: 'Germany',
    comment: 'Monthly blues club night. Small guarantee but reliable.',
  },
  {
    name: 'Munich Blues Society', type: 'Association',
    email: 'mbs@mbsociety.example.de', city: 'Munich', country: 'Germany',
    comment: 'Enthusiastic audience. Help with local logistics.',
  },
  {
    name: 'Benelux Booking', type: 'Agency',
    email: 'info@beneluxbooking.example.be', website: 'https://beneluxbooking.example.be',
    city: 'Brussels', country: 'Belgium',
    comment: 'Handles Belgium, Netherlands, Luxembourg routing.',
  },
  {
    name: 'Le Réseau Folk', type: 'Association',
    email: 'reseau@reseaufolk.example.fr', city: 'Rennes', country: 'France',
    comment: 'Breton folk network — occasional crossover bookings.',
  },
  {
    name: 'Suisse Musique', type: 'Agency',
    email: 'booking@suissemusique.example.ch', city: 'Zurich', country: 'Switzerland',
    comment: 'Swiss market entry. Pays well.',
  },
  {
    name: 'Festival Jazz à Vienne', type: 'Festival',
    email: 'artists@jazzavienne.example.fr', city: 'Vienne', country: 'France',
    comment: 'Prestigious summer festival. Long lead times required.',
  },
  {
    name: 'Les Nuits de Fourvière', type: 'Festival',
    email: 'prog@nuitsdefourviere.example.fr', city: 'Lyon', country: 'France',
    comment: 'Roman amphitheatre festival. Very atmospheric.',
  },
  {
    name: 'Ambiances Jazz', type: 'Association',
    email: 'contact@ambiancesjazz.example.fr', city: 'Nantes', country: 'France',
    comment: 'Jazz and blues crossover series.',
  },
  {
    name: 'Weimar Blues Night', type: 'Club',
    email: 'blues@weimarblues.example.de', city: 'Weimar', country: 'Germany',
    comment: 'Small but passionate audience.',
  },
  {
    name: 'Roots & Routes', type: 'Promoter',
    email: 'info@rootsandroutes.example.fr', city: 'Toulouse', country: 'France',
    comment: 'Specialises in Americana, roots, blues.',
  },
  {
    name: 'Strasbourg Live', type: 'Agency',
    email: 'booking@strasbourglive.example.fr', city: 'Strasbourg', country: 'France',
    comment: 'Good cross-border Germany/France routing.',
  },
  {
    name: 'Vienna Blues Society', type: 'Association',
    email: 'vbs@viennesblues.example.at', city: 'Vienna', country: 'Austria',
    comment: 'Well-organised. Annual festival in October.',
  },
  {
    name: 'Private Events Sud', type: 'Agency',
    email: 'events@privatesud.example.fr', city: 'Montpellier', country: 'France',
    comment: 'Handles weddings and private events in the south.',
  },
  {
    name: 'Occitanie Concerts', type: 'Association',
    email: 'prog@occitanieconcerts.example.fr', city: 'Toulouse', country: 'France',
    comment: 'Regional cultural association. EU funding sometimes available.',
  },
  {
    name: 'Celtic Connexion', type: 'Festival',
    email: 'artists@celticconnexion.example.fr', city: 'Lorient', country: 'France',
    comment: 'Celtic/folk/world music focus. Occasional blues crossover.',
  },
  {
    name: 'Alpes Live', type: 'Promoter',
    email: 'booking@alpeslive.example.fr', city: 'Grenoble', country: 'France',
    comment: 'Mountain region circuit — unique atmosphere.',
  },
  {
    name: 'Köln Musik', type: 'Agency',
    email: 'info@koelnmusik.example.de', city: 'Cologne', country: 'Germany',
    comment: 'Large agency, good for support slots.',
  },
  {
    name: 'Mairie de Lyon — Culture', type: 'Association',
    email: 'culture@mairie-lyon.example.fr', city: 'Lyon', country: 'France',
    comment: 'Municipal cultural events. Outdoor summer concerts.',
  },
  {
    name: 'Blues Around the World', type: 'Festival',
    email: 'info@bluesaroundtheworld.example.org', city: 'Cognac', country: 'France',
    comment: 'International blues festival. Good for profile building.',
  },
  {
    name: 'Haute Fidélité', type: 'Promoter',
    email: 'contact@hautefidelite.example.fr', city: 'Paris', country: 'France',
    phone: '+33 1 98 76 54 32',
    comment: 'Paris-based promoter. Focused on quality over quantity.',
  },
  {
    name: 'Swiss Blues Night', type: 'Festival',
    email: 'info@swissbluesnight.example.ch', city: 'Pratteln', country: 'Switzerland',
    comment: 'Biggest blues event in Switzerland.',
  },
  {
    name: 'Ateliers du Vieux-Biscuit', type: 'Club',
    email: 'prog@avb.example.fr', city: 'Bordeaux', country: 'France',
    comment: 'Artisan venue, small capacity but press-friendly.',
  },
  {
    name: 'Eurocks Booking', type: 'Agency',
    email: 'booking@eurocks.example.fr', city: 'Belfort', country: 'France',
    website: 'https://eurocks.example.fr',
    comment: 'Connected to Eurockeennes festival.',
  },
];

// venue_key and organizer_key reference VENUES[*].name and ORGANIZERS[*].name
// ── Generated CRM data ─────────────────────────────────────────────────────

const CRM_PLACES = [
  ['Berlin', 'DE', '10115'], ['Hamburg', 'DE', '20095'], ['Köln', 'DE', '50667'], ['Leipzig', 'DE', '04109'],
  ['Freiburg', 'DE', '79098'], ['Wien', 'AT', '1010'], ['Graz', 'AT', '8010'], ['Zürich', 'CH', '8001'],
  ['Basel', 'CH', '4001'], ['Lyon', 'FR', '69001'], ['Nantes', 'FR', '44000'], ['Brest', 'FR', '29200'],
  ['Strasbourg', 'FR', '67000'], ['Gent', 'BE', '9000'], ['Utrecht', 'NL', '3511'], ['Aarhus', 'DK', '8000'],
];
const CRM_WORDS = ['Alte Mühle', 'Blue Note', 'Club Cave', 'Dorfkrug', 'Eulenspiegel', 'Fabrik', 'Grüner Salon',
  'Hafenbar', 'Irish Pub', 'Jazzkeller', 'Kulturhaus', 'Lindenhof', 'Musikbunker', 'Nachtcafé', 'Offene Bühne',
  'Pavillon', 'Quartier', 'Rathauskeller', 'Scheune', 'Theaterhaus', 'Unterwerk', 'Villa Kunterbunt',
  'Weinstube', 'Xtra Bar', 'Yard Stage', 'Zollhaus', '3Klang', '1. Stock', 'Ölmühle', 'Éclat'];
const CRM_STATUSES   = ['prospect', 'contacted', 'confirmed', 'active', 'declined'];
const CRM_CATEGORIES = ['association', 'club', 'festival', 'private', 'pub', 'restaurant', 'street'];
const CRM_ORG_TYPES  = ['person', 'organization', 'event', 'press', 'radio'];
const CRM_ORG_WORDS  = ['Agentur', 'Booking', 'Festival', 'Kulturverein', 'Radio', 'Presse', 'Konzertbüro', 'Stadtfest'];

// Deterministic, so a reseed produces the same rows.
function generateCrmRows(artistId) {
  const venues = [];
  CRM_WORDS.forEach((word, w) => {
    for (let i = 0; i < 5; i++) {
      const [city, country, postcode] = CRM_PLACES[(w * 5 + i) % CRM_PLACES.length];
      const n = w * 5 + i;
      venues.push({
        artist_id: artistId, name: `${word} ${city}`, city, country, postcode,
        size: 50 + (n * 37) % 950,
        status: CRM_STATUSES[n % CRM_STATUSES.length],
        category: CRM_CATEGORIES[n % CRM_CATEGORIES.length],
        generic_email: `booking${n}@example.org`,
        heart: n % 11 === 0,
      });
    }
  });
  const organizers = [];
  CRM_ORG_WORDS.forEach((word, w) => {
    CRM_PLACES.forEach(([city, country], p) => {
      if ((w + p) % 2) return;
      const n = w * CRM_PLACES.length + p;
      organizers.push({
        artist_id: artistId, name: `${word} ${city}`, type: CRM_ORG_TYPES[n % CRM_ORG_TYPES.length],
        email: `contact${n}@example.org`, city, country,
        heart: n % 9 === 0,
      });
    });
  });
  return { venues, organizers };
}

const GIGS = [
  // ── 2022 ──────────────────────────────────────────────────────────────────
  {
    title: 'Blues at Café Central', date: '2022-03-12', type: 'concert',
    time_start: '20:30', time_end: '22:30',
    venue_key: 'Café Central', organizer_key: 'Jazz & Blues Prod',
    comment: 'Brussels debut. Small crowd but very warm reception.',
  },
  {
    title: 'Le Chat Noir Spring Night', date: '2022-05-07', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Le Chat Noir', organizer_key: 'Rhône Blues Collective',
    comment: 'Return show after March sell-out.',
  },
  {
    title: 'Roots & Routes Showcase', date: '2022-07-15', type: 'festival',
    time_start: '19:00', time_end: '20:30',
    venue_key: 'La Ferronnerie', organizer_key: 'Roots & Routes',
    comment: '45-min showcase slot. Journalist from Le Monde présent.',
  },
  {
    title: 'Kulturzentrum am Schloss — Autumn', date: '2022-09-24', type: 'concert',
    time_start: '20:00', time_end: '22:00',
    venue_key: 'Kulturzentrum am Schloss', organizer_key: 'Kultur Büro Rhein',
    comment: 'First German gig. Went very well.',
  },
  {
    title: 'Folk Folk Folk — Rennes', date: '2022-11-19', type: 'concert',
    time_start: '21:00', time_end: '22:30',
    venue_key: 'Le Brin de Zinc', organizer_key: 'Le Réseau Folk',
  },
  // ── 2023 ──────────────────────────────────────────────────────────────────
  {
    title: 'Substage Winter Blues', date: '2023-01-28', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Substage', organizer_key: 'Blues im Keller',
    comment: 'Karlsruhe crowd loves blues. Pack the pedalboard.',
  },
  {
    title: 'Bi Nuu Berlin', date: '2023-03-11', type: 'concert',
    time_start: '20:30', time_end: '22:30',
    venue_key: 'Bi Nuu', organizer_key: 'Kultur Büro Rhein',
    comment: 'Berlin debut. Promote this properly.',
  },
  {
    title: 'Nuits de Printemps — Lyon', date: '2023-05-06', type: 'festival',
    time_start: '18:30', time_end: '20:00',
    venue_key: 'L\'Épicerie Moderne', organizer_key: 'Les Nuits de Fourvière',
    comment: '90-min set. Bring acoustic guitars as backup.',
  },
  {
    title: 'Strom Summer Night', date: '2023-07-22', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Strom', organizer_key: 'Munich Blues Society',
  },
  {
    title: 'Blues Night at Le Chat Noir', date: '2023-09-14', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Le Chat Noir', organizer_key: 'Jazz & Blues Prod',
    comment: 'Outdoor courtyard — bring the extra PA.',
  },
  {
    title: 'Ambiances Jazz — Nantes', date: '2023-10-28', type: 'concert',
    time_start: '20:00', time_end: '22:00',
    venue_key: 'Le Chabada', organizer_key: 'Ambiances Jazz',
    comment: 'Jazz/blues crossover crowd. Softer set works well.',
  },
  {
    title: 'Vienna Blues Society Annual Show', date: '2023-12-02', type: 'concert',
    time_start: '20:30', time_end: '22:30',
    venue_key: 'WUK', organizer_key: 'Vienna Blues Society',
    comment: 'Long trip but very worthwhile. Audience very knowledgeable.',
  },
  // ── 2024 ──────────────────────────────────────────────────────────────────
  {
    title: 'Papiersaal Zurich', date: '2024-02-10', type: 'concert',
    time_start: '20:00', time_end: '22:00',
    venue_key: 'Papiersaal', organizer_key: 'Suisse Musique',
    comment: 'Swiss debut. Good fee. Plan return tour.',
  },
  {
    title: 'Espace Aragon — Blues Edition', date: '2024-04-19', type: 'concert',
    time_start: '20:30', time_end: '22:30',
    venue_key: 'Espace Aragon', organizer_key: 'Strasbourg Live',
  },
  {
    title: 'Le Moloco Spring', date: '2024-05-25', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Le Moloco', organizer_key: 'Jazz & Blues Prod',
    comment: 'Franche-Comté audience very enthusiastic.',
  },
  {
    title: 'Festival du Bout du Monde', date: '2024-07-05', type: 'festival',
    time_start: '16:30', time_end: '18:00',
    venue_key: 'Parc des Expositions', organizer_key: 'Festival du Bout du Monde',
    comment: 'Biggest crowd to date — 3000+. Afternoon slot.',
  },
  {
    title: 'Blues Around the World — Cognac', date: '2024-09-07', type: 'festival',
    time_start: '19:00', time_end: '20:30',
    venue_key: 'La Maison Bleue', organizer_key: 'Blues Around the World',
  },
  {
    title: 'Hirsch Autumn Blues', date: '2024-10-12', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Hirsch', organizer_key: 'Kultur Büro Rhein',
    comment: 'Nuremberg show. Strong ticket pre-sales.',
  },
  {
    title: 'Haute Fidélité — Paris Showcase', date: '2024-11-08', type: 'concert',
    time_start: '20:00', time_end: '21:30',
    venue_key: 'Le Trabendo', organizer_key: 'Haute Fidélité',
    comment: 'Industry showcase. Several labels in audience.',
  },
  {
    title: 'De Helling — Utrecht Blues Night', date: '2024-12-14', type: 'concert',
    time_start: '20:30', time_end: '22:30',
    venue_key: 'De Helling', organizer_key: 'Benelux Booking',
    comment: 'Dutch debut.',
  },
  // ── 2025 ──────────────────────────────────────────────────────────────────
  {
    title: 'Swiss Blues Night — Pratteln', date: '2025-03-01', type: 'festival',
    time_start: '20:00', time_end: '21:30',
    venue_key: 'Papiersaal', organizer_key: 'Swiss Blues Night',
    comment: 'Return to Switzerland. Sold out pre-sale.',
  },
  {
    title: 'Strom — Munich Spring', date: '2025-04-26', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Strom', organizer_key: 'Munich Blues Society',
  },
  {
    title: 'Blues at Café Central II', date: '2025-06-07', type: 'concert',
    time_start: '20:30', time_end: '22:30',
    venue_key: 'Café Central', organizer_key: 'Benelux Booking',
    comment: 'Return Brussels show. New album material.',
  },
  // ── 2025 Future ───────────────────────────────────────────────────────────
  {
    title: 'Substage Autumn Tour', date: '2025-10-04', type: 'concert',
    time_start: '21:00', time_end: '23:00',
    venue_key: 'Substage', organizer_key: 'Kultur Büro Rhein',
    comment: 'Confirmed. Headline slot.',
  },
  {
    title: 'Ambiances Jazz — Nantes Winter', date: '2025-11-29', type: 'concert',
    time_start: '20:00', time_end: '22:00',
    venue_key: 'Stereolux', organizer_key: 'Ambiances Jazz',
  },
  // ── Existing gigs ─────────────────────────────────────────────────────────
  {
    title: 'Summer Open Air 2026', date: '2026-06-20', type: 'festival',
    time_start: '20:30', time_end: '21:30',
    venue_key: 'Parc des Expositions', organizer_key: 'Jazz & Blues Prod',
    comment: 'Confirmed 60-min slot.',
  },
  {
    title: 'WUK Vienna — Spring Blues', date: '2026-04-11', type: 'concert',
    time_start: '20:00', time_end: '22:00',
    venue_key: 'WUK', organizer_key: 'Vienna Blues Society',
    comment: 'Return Vienna show. Possibly record live.',
  },
  {
    title: 'Warm-up Show (TBD)', date: null, type: 'concert',
    time_start: null, time_end: null,
    venue_key: null, organizer_key: 'Self-organized',
    comment: 'Venue shortlist: Le Cargo (Rouen), La Maison Bleue (Bordeaux).',
  },
];

// songs: array of song titles to look up from SONGS above
const SETLISTS = [
  // ── 2022 ──────────────────────────────────────────────────────────────────
  {
    title: 'Brussels Opener', gig_title: 'Blues at Café Central',
    comment: 'First Belgium show — keep it accessible',
    songs: ['Crossroads', 'Ain\'t No Sunshine', 'Stand By Me', 'Pride and Joy',
            'Redemption Song', 'Midnight Drive', 'Come Together'],
  },
  {
    title: 'Chat Noir Spring Set', gig_title: 'Le Chat Noir Spring Night',
    comment: 'Outdoor night, crowd warms up fast',
    songs: ['Midnight Drive', 'La Grange', 'The Thrill Is Gone', 'Mustang Sally',
            'No Woman, No Cry', 'River Town Blues', 'Whole Lotta Love', 'Crossroads'],
  },
  {
    title: 'Roots Showcase 45 min', gig_title: 'Roots & Routes Showcase',
    comment: 'Showcase slot — tight and punchy',
    songs: ['Morning Light', 'Wagon Wheel', 'Blowin\' in the Wind', 'Broken Strings',
            'The Weight', 'Midnight Drive'],
  },
  {
    title: 'Heidelberg Acoustic', gig_title: 'Kulturzentrum am Schloss — Autumn',
    comment: 'Attentive German crowd — go acoustic-heavy',
    songs: ['Morning Light', 'Old Man', 'Fields of Gold', 'Redemption Song',
            'Wonderful Tonight', 'The Wanderer', 'Broken Strings', 'Blowin\' in the Wind'],
  },
  {
    title: 'Folk Night Rennes', gig_title: 'Folk Folk Folk — Rennes',
    songs: ['The Wanderer', 'Wagon Wheel', 'Morning Light', 'Old Man',
            'Take Me Home, Country Roads', 'Last Train South', 'Fields of Gold'],
  },
  // ── 2023 ──────────────────────────────────────────────────────────────────
  {
    title: 'Karlsruhe Blues Night', gig_title: 'Substage Winter Blues',
    comment: 'Blues crowd — go deep and dirty',
    songs: ['Born Under a Bad Sign', 'La Grange', 'Pride and Joy', 'The Thrill Is Gone',
            'River Town Blues', 'Crossroads', 'Empty Room', 'Whole Lotta Love'],
  },
  {
    title: 'Berlin Set', gig_title: 'Bi Nuu Berlin',
    comment: 'Berlin debut — mix of styles, start with impact',
    songs: ['Highway Star', 'Midnight Drive', 'All Along the Watchtower',
            'Roxanne', 'Smoke and Mirrors', 'Little Wing', 'Hotel California',
            'Come Together', 'River Town Blues'],
  },
  {
    title: 'Lyon Spring Festival Set', gig_title: 'Nuits de Printemps — Lyon',
    comment: '90-min set — full show',
    songs: ['Midnight Drive', 'La Grange', 'Crossroads', 'Ain\'t No Sunshine',
            'Morning Light', 'The Wanderer', 'Born Under a Bad Sign', 'Pride and Joy',
            'Superstition', 'Mustang Sally', 'River Town Blues', 'Whole Lotta Love'],
  },
  {
    title: 'Munich Summer Night', gig_title: 'Strom Summer Night',
    songs: ['Smoke and Mirrors', 'All Along the Watchtower', 'Born Under a Bad Sign',
            'Georgia on My Mind', 'Empty Room', 'Midnight Drive', 'Crossroads'],
  },
  {
    title: 'Blues Night at Le Chat Noir — full set', gig_title: 'Blues Night at Le Chat Noir',
    comment: '45 min outdoor set — keep it punchy',
    songs: ['Crossroads', 'Pride and Joy', 'The Thrill Is Gone', 'Superstition',
            'River Town Blues', 'Come Together', 'Whole Lotta Love', 'Midnight Drive'],
  },
  {
    title: 'Nantes Jazz Crossover', gig_title: 'Ambiances Jazz — Nantes',
    comment: 'Jazz crowd — lean on slower material',
    songs: ['Feeling Good', 'Georgia on My Mind', 'Ain\'t No Sunshine', 'Tears in Heaven',
            'Fields of Gold', 'The Weight', 'Wonderful Tonight', 'Morning Light'],
  },
  {
    title: 'Vienna Annual Show', gig_title: 'Vienna Blues Society Annual Show',
    comment: 'Knowledgeable crowd — can stretch solos',
    songs: ['Born Under a Bad Sign', 'La Grange', 'Little Wing', 'The Thrill Is Gone',
            'Pride and Joy', 'Empty Room', 'River Town Blues', 'Crossroads',
            'Midnight Drive', 'Whole Lotta Love'],
  },
  // ── 2024 ──────────────────────────────────────────────────────────────────
  {
    title: 'Zurich Show', gig_title: 'Papiersaal Zurich',
    songs: ['Midnight Drive', 'Smoke and Mirrors', 'All Along the Watchtower',
            'Pride and Joy', 'Feeling Good', 'River Town Blues', 'Hotel California',
            'With or Without You', 'Crossroads'],
  },
  {
    title: 'Strasbourg Blues Set', gig_title: 'Espace Aragon — Blues Edition',
    songs: ['Born Under a Bad Sign', 'Crossroads', 'The Thrill Is Gone', 'Mustang Sally',
            'Ain\'t No Sunshine', 'River Town Blues', 'Empty Room', 'Midnight Drive'],
  },
  {
    title: 'Le Moloco Full Set', gig_title: 'Le Moloco Spring',
    comment: 'Loud crowd — go full rock',
    songs: ['Highway Star', 'La Grange', 'Smoke and Mirrors', 'Little Wing',
            'Whole Lotta Love', 'Midnight Drive', 'Hotel California', 'Roxanne',
            'Come Together', 'River Town Blues'],
  },
  {
    title: 'Festival du Bout du Monde — afternoon set', gig_title: 'Festival du Bout du Monde',
    comment: '90-min afternoon slot — 3000+ crowd',
    songs: ['Midnight Drive', 'Highway Star', 'Crossroads', 'River Town Blues',
            'Pride and Joy', 'Superstition', 'Come Together', 'No Woman, No Cry',
            'Whole Lotta Love', 'Wagon Wheel', 'Morning Light', 'The Weight'],
  },
  {
    title: 'Cognac Festival Short Set', gig_title: 'Blues Around the World — Cognac',
    songs: ['Crossroads', 'Born Under a Bad Sign', 'The Thrill Is Gone',
            'River Town Blues', 'Pride and Joy', 'Midnight Drive'],
  },
  {
    title: 'Nuremberg Autumn', gig_title: 'Hirsch Autumn Blues',
    songs: ['Highway Star', 'All Along the Watchtower', 'La Grange', 'Smoke and Mirrors',
            'Crossroads', 'Empty Room', 'Midnight Drive', 'River Town Blues'],
  },
  {
    title: 'Paris Industry Showcase', gig_title: 'Haute Fidélité — Paris Showcase',
    comment: 'Labels in the room — put best songs forward',
    songs: ['Midnight Drive', 'River Town Blues', 'Morning Light', 'Smoke and Mirrors',
            'The Wanderer', 'Broken Strings', 'Last Train South', 'Empty Room'],
  },
  {
    title: 'Utrecht Blues Night', gig_title: 'De Helling — Utrecht Blues Night',
    songs: ['Born Under a Bad Sign', 'La Grange', 'Crossroads', 'Pride and Joy',
            'River Town Blues', 'Midnight Drive', 'Whole Lotta Love', 'The Thrill Is Gone'],
  },
  // ── 2025 ──────────────────────────────────────────────────────────────────
  {
    title: 'Swiss Blues Night Set', gig_title: 'Swiss Blues Night — Pratteln',
    comment: 'Sold out — bring the full energy',
    songs: ['La Grange', 'Born Under a Bad Sign', 'Midnight Drive', 'Crossroads',
            'The Thrill Is Gone', 'River Town Blues', 'Pride and Joy', 'Whole Lotta Love'],
  },
  {
    title: 'Munich April Set', gig_title: 'Strom — Munich Spring',
    songs: ['Smoke and Mirrors', 'Midnight Drive', 'All Along the Watchtower',
            'Georgia on My Mind', 'River Town Blues', 'La Grange', 'Crossroads'],
  },
  {
    title: 'Brussels Return Show', gig_title: 'Blues at Café Central II',
    comment: 'New album material — test reactions',
    songs: ['Midnight Drive', 'River Town Blues', 'Morning Light', 'Empty Room',
            'Broken Strings', 'Last Train South', 'Smoke and Mirrors', 'The Wanderer'],
  },
  // ── 2026 ──────────────────────────────────────────────────────────────────
  {
    title: 'Summer Open Air 2026 — 60 min', gig_title: 'Summer Open Air 2026',
    comment: 'Full hour set — end on high energy',
    songs: ['Midnight Drive', 'Highway Star', 'Crossroads', 'River Town Blues',
            'Pride and Joy', 'Superstition', 'Come Together', 'No Woman, No Cry',
            'Whole Lotta Love', 'Wagon Wheel'],
  },
  {
    title: 'Vienna Spring Show', gig_title: 'WUK Vienna — Spring Blues',
    comment: 'Possibly record live — best performance',
    songs: ['Born Under a Bad Sign', 'La Grange', 'Little Wing', 'The Thrill Is Gone',
            'Feeling Good', 'Empty Room', 'River Town Blues', 'Midnight Drive',
            'All Along the Watchtower', 'Crossroads', 'Whole Lotta Love'],
  },
  // ── Standalone templates ───────────────────────────────────────────────────
  {
    title: 'Short set template (30 min)', gig_title: null,
    comment: 'Reusable template for small venues and private events',
    songs: ['Crossroads', 'Signed, Sealed, Delivered', 'Redemption Song',
            'Midnight Drive', 'Come Together', 'The House of the Rising Sun'],
  },
  {
    title: 'Acoustic set template', gig_title: null,
    comment: 'Duo/trio acoustic format — no drums',
    songs: ['Morning Light', 'Fields of Gold', 'Blowin\' in the Wind', 'Old Man',
            'Wonderful Tonight', 'The Wanderer', 'Last Train South', 'Redemption Song',
            'Wagon Wheel', 'Knockin\' on Heaven\'s Door'],
  },
  {
    title: 'Heavy blues set template', gig_title: null,
    comment: 'For big stages and outdoor festivals',
    songs: ['La Grange', 'Born Under a Bad Sign', 'Highway Star', 'Whole Lotta Love',
            'Pride and Joy', 'Crossroads', 'The Thrill Is Gone', 'River Town Blues',
            'Midnight Drive', 'Come Together', 'Little Wing', 'All Along the Watchtower'],
  },
  {
    title: 'Substage Autumn Tour Setlist', gig_title: 'Substage Autumn Tour',
    comment: 'Headline slot — full show',
    songs: ['Highway Star', 'Smoke and Mirrors', 'La Grange', 'Crossroads',
            'Midnight Drive', 'River Town Blues', 'All Along the Watchtower',
            'Little Wing', 'Pride and Joy', 'Hotel California', 'Whole Lotta Love'],
  },
  {
    title: 'Nantes Winter Jazz Set', gig_title: 'Ambiances Jazz — Nantes Winter',
    songs: ['Feeling Good', 'Georgia on My Mind', 'Ain\'t No Sunshine', 'Fields of Gold',
            'Tears in Heaven', 'Morning Light', 'The Wanderer', 'Wonderful Tonight'],
  },
];

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  await lib.confirmDb(DATABASE_URL);

  console.log(`\n${B('Smartist — Dev seeder')}`);
  console.log(D('─'.repeat(44)));

  const slug = process.env.ARTIST_SLUG;
  let artist;
  if (slug) {
    [artist] = await sql`SELECT * FROM artists WHERE slug = ${slug}`;
    if (!artist) {
      err(`Artist with slug "${slug}" not found. Run setup.js first.`);
      process.exit(1);
    }
  } else {
    [artist] = await sql`SELECT * FROM artists ORDER BY id LIMIT 1`;
    if (!artist) {
      err('No artists in the database. Run setup.js first to create one.');
      process.exit(1);
    }
    warn(`ARTIST_SLUG not set — targeting first artist: "${artist.name}" (${artist.slug})`);
  }

  ok(`Artist: ${B(artist.name)} (slug: ${artist.slug}, id: ${artist.id})`);

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM songs WHERE artist_id = ${artist.id}`;
  if (count > 0 && !FORCE) {
    warn(`Database already has ${count} song(s) for this artist.`);
    warn('Use --force to wipe and reseed.');
    process.exit(0);
  }

  if (FORCE && count > 0) {
    warn(`Wiping existing data for artist ${artist.slug}…`);
    await sql`DELETE FROM gema_works  WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM setlists    WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM gigs        WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM venues      WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM organizers  WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM song_logs   WHERE artist_id = ${artist.id}`;
    await sql`DELETE FROM songs       WHERE artist_id = ${artist.id}`;
    ok('Existing data cleared.');
  }

  // ── Songs ─────────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting songs…')}`);
  const songRows = [];
  for (const s of SONGS) {
    // Lyrics and language are columns now (song_lyrics, songs.language), not extra keys.
    const { lyrics = null, language = null, ...extra } = s.extra ?? {};
    const [row] = await sql`
      INSERT INTO songs (artist_id, title, active, heart, key, genre, energy, time_signature,
                         length_min, interpret, reference_interpret, comment, language, extra)
      VALUES (${artist.id}, ${s.title}, ${s.active}, ${s.heart ?? false}, ${s.key ?? null},
              ${s.genre ?? null}, ${s.energy ?? null}, ${s.time_signature ?? null},
              ${s.length_min ?? null}, ${s.interpret ?? null}, ${s.reference_interpret ?? null},
              ${s.comment ?? null}, ${language}, ${extra})
      RETURNING *
    `;
    if (lyrics) {
      await sql`INSERT INTO song_lyrics (song_id, artist_id, lyrics) VALUES (${row.id}, ${artist.id}, ${lyrics})`;
    }
    songRows.push(row);
    ok(`  ${row.active ? '' : D('[inactive] ')}${row.title}`);
  }

  // ── Song audit log ────────────────────────────────────────────────────────

  console.log(`\n  ${B('Writing song audit log…')}`);
  for (const row of songRows) {
    await sql`
      INSERT INTO song_logs (artist_id, song_id, action, song_data, changed_at)
      VALUES (${artist.id}, ${row.id}, 'create', ${row}, NOW() - interval '90 days')
    `;
  }
  for (const row of songRows.slice(0, 8)) {
    await sql`
      INSERT INTO song_logs (artist_id, song_id, action, song_data, changed_at)
      VALUES (${artist.id}, ${row.id}, 'update', ${row}, NOW() - interval '30 days')
    `;
  }
  const deletedSong = songRows.find(r => !r.active);
  if (deletedSong) {
    await sql`
      INSERT INTO song_logs (artist_id, song_id, action, song_data, changed_at)
      VALUES (${artist.id}, ${deletedSong.id}, 'delete', ${deletedSong}, NOW() - interval '10 days')
    `;
  }
  ok(`${songRows.length + 9} log entries written.`);

  // ── Venues ────────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting venues…')}`);
  const venueByName = {};
  for (const v of VENUES) {
    const [row] = await sql`
      INSERT INTO venues (artist_id, name, city, country, postcode, state, size,
                          status, category, website, generic_email, booking_channel,
                          comment, main_genre, turnus, season)
      VALUES (
        ${artist.id}, ${v.name}, ${v.city ?? null}, ${v.country ?? null},
        ${v.postcode ?? null}, ${v.state ?? null}, ${v.size ?? null},
        ${v.status ?? null}, ${v.category ?? null}, ${v.website ?? null},
        ${v.generic_email ?? null}, ${v.booking_channel ?? null},
        ${v.comment ?? null}, ${v.main_genre ?? null}, ${v.turnus ?? null},
        ${v.season ?? null}
      )
      RETURNING *
    `;
    venueByName[v.name] = row;
    ok(`  ${row.name}${row.city ? D(` — ${row.city}`) : ''}`);
  }

  // ── Organizers ────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting organizers…')}`);
  const organizerByName = {};
  for (const o of ORGANIZERS) {
    const [row] = await sql`
      INSERT INTO organizers (artist_id, name, type, email, phone, website,
                              city, country, comment)
      VALUES (
        ${artist.id}, ${o.name}, ${o.type ?? null}, ${o.email ?? null},
        ${o.phone ?? null}, ${o.website ?? null},
        ${o.city ?? null}, ${o.country ?? null}, ${o.comment ?? null}
      )
      RETURNING *
    `;
    organizerByName[o.name] = row;
    ok(`  ${row.name}${row.type ? D(` (${row.type})`) : ''}`);
  }

  // ── Generated CRM rows ────────────────────────────────────────────────────
  // Enough venues and organizers to exercise paging (50 per page), the A–Z bar
  // (including '#' for non-alphabetic names) and the favourites filter.

  console.log(`\n  ${B('Inserting generated venues and organizers…')}`);
  const { venues: extraVenues, organizers: extraOrganizers } = generateCrmRows(artist.id);
  // postgres.js cannot send a JS boolean array: booleans go as text, cast via text[]::bool[].
  const col = (rows, k) => rows.map(r => typeof r[k] === 'boolean' ? String(r[k]) : r[k]);
  await sql`
    INSERT INTO venues (artist_id, name, city, country, postcode, size, status, category, generic_email, heart)
    SELECT ${artist.id}, * FROM unnest(
      ${col(extraVenues, 'name')}::text[], ${col(extraVenues, 'city')}::text[], ${col(extraVenues, 'country')}::text[],
      ${col(extraVenues, 'postcode')}::text[], ${col(extraVenues, 'size')}::int[], ${col(extraVenues, 'status')}::text[],
      ${col(extraVenues, 'category')}::text[], ${col(extraVenues, 'generic_email')}::text[], ${col(extraVenues, 'heart')}::text[]::bool[])`;
  await sql`
    INSERT INTO organizers (artist_id, name, type, email, city, country, heart)
    SELECT ${artist.id}, * FROM unnest(
      ${col(extraOrganizers, 'name')}::text[], ${col(extraOrganizers, 'type')}::text[], ${col(extraOrganizers, 'email')}::text[],
      ${col(extraOrganizers, 'city')}::text[], ${col(extraOrganizers, 'country')}::text[], ${col(extraOrganizers, 'heart')}::text[]::bool[])`;
  ok(`  ${extraVenues.length} venues, ${extraOrganizers.length} organizers`);

  // ── Gigs ──────────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting gigs…')}`);
  const gigRows = [];
  const gigByTitle = {};
  for (const g of GIGS) {
    const venueId     = g.venue_key     ? (venueByName[g.venue_key]?.id     ?? null) : null;
    const organizerId = g.organizer_key ? (organizerByName[g.organizer_key]?.id ?? null) : null;
    const [row] = await sql`
      INSERT INTO gigs (artist_id, title, date, venue_id, organizer_id,
                        type, time_start, time_end, comment)
      VALUES (
        ${artist.id}, ${g.title}, ${g.date ?? null},
        ${venueId}, ${organizerId},
        ${g.type ?? null}, ${g.time_start ?? null}, ${g.time_end ?? null},
        ${g.comment ?? null}
      )
      RETURNING *
    `;
    gigRows.push(row);
    gigByTitle[g.title] = row;
    const venueLabel = g.venue_key ?? '(TBD)';
    ok(`  ${row.title}${row.date ? D(` — ${String(row.date).slice(0,10)}`) : D(' (TBD)')} @ ${D(venueLabel)}`);
  }

  // ── Setlists ──────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Building setlists…')}`);

  async function makeSetlist({ title, comment, gigId, songIds }) {
    const [sl] = await sql`
      INSERT INTO setlists (artist_id, title, gig_id, comment)
      VALUES (${artist.id}, ${title ?? null}, ${gigId ?? null}, ${comment ?? null})
      RETURNING *
    `;
    if (songIds.length > 0) {
      const slIds = songIds.map(() => sl.id);
      const posns = songIds.map((_, i) => i);
      await sql`
        INSERT INTO setlist_songs (setlist_id, song_id, position)
        SELECT * FROM unnest(${slIds}::int[], ${songIds}::int[], ${posns}::int[])
      `;
    }
    return sl;
  }

  const byTitle = Object.fromEntries(songRows.map(r => [r.title, r.id]));

  let missingCount = 0;
  for (const sl of SETLISTS) {
    const gigId  = sl.gig_title ? (gigByTitle[sl.gig_title]?.id ?? null) : null;
    if (sl.gig_title && !gigByTitle[sl.gig_title]) {
      warn(`  Setlist "${sl.title}": gig "${sl.gig_title}" not found — creating unlinked`);
    }
    const songIds = sl.songs.map(t => {
      const id = byTitle[t];
      if (!id) { warn(`  Song not found: "${t}" (in setlist "${sl.title}")`); missingCount++; }
      return id;
    }).filter(Boolean);
    const row = await makeSetlist({ title: sl.title, comment: sl.comment ?? null, gigId, songIds });
    ok(`  ${row.title}${gigId ? '' : D(' [template]')} (${songIds.length} songs)`);
  }
  if (missingCount > 0) warn(`  ${missingCount} song reference(s) not resolved — check spelling`);

  // ── GEMA works ────────────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting GEMA works…')}`);
  const performers = artist.name.toUpperCase();

  const [gw1] = await sql`
    INSERT INTO gema_works
      (artist_id, gema_work_number, title, iswc, language, performers,
       gema_genre, duration_sec, first_registered_at, last_updated_at, song_id)
    VALUES
      (${artist.id}, '10000001-001', 'MIDNIGHT DRIVE', 'T0000000001',
       'EN', ${performers}, 'ROCK', 225,
       '2023-01-15', '2024-03-01', ${byTitle['Midnight Drive'] ?? null})
    RETURNING *
  `;
  ok('  MIDNIGHT DRIVE (10000001-001)');

  const [gw2] = await sql`
    INSERT INTO gema_works
      (artist_id, gema_work_number, title, iswc, language, performers,
       gema_genre, duration_sec, first_registered_at, last_updated_at, song_id)
    VALUES
      (${artist.id}, '10000002-001', 'RIVER TOWN BLUES', 'T0000000002',
       'EN', ${performers}, 'BLUES', 255,
       '2023-01-15', '2024-03-01', ${byTitle['River Town Blues'] ?? null})
    RETURNING *
  `;
  ok('  RIVER TOWN BLUES (10000002-001)');

  // ── GEMA rightholders ─────────────────────────────────────────────────────

  console.log(`\n  ${B('Inserting GEMA rightholders…')}`);
  for (const [workId, workLabel] of [[gw1.id, 'MIDNIGHT DRIVE'], [gw2.id, 'RIVER TOWN BLUES']]) {
    await sql`
      INSERT INTO gema_rightholders
        (gema_work_id, name, ip_name_number, role,
         ar_share, vr_share, ar_share_cumulated, vr_share_cumulated,
         society_ar, society_vr)
      VALUES
        (${workId}, 'DOE ALEX',             '100000001', 'composer',
         66.67, 66.67, 66.67, 66.67, 'GEMA', 'GEMA'),
        (${workId}, 'SMITH JANE',           '100000002', 'lyricist',
         33.33, 33.33, 33.33, 33.33, 'GEMA', 'GEMA'),
        (${workId}, 'MUSIC PUBLISHER GMBH', '100000003', 'publisher',
         0.00,  0.00,  0.00,  0.00,  'GEMA', 'GEMA')
    `;
    ok(`  3 rightholders → ${workLabel}`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────

  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM songs      WHERE artist_id = ${artist.id}) AS songs,
      (SELECT COUNT(*)::int FROM venues     WHERE artist_id = ${artist.id}) AS venues,
      (SELECT COUNT(*)::int FROM organizers WHERE artist_id = ${artist.id}) AS organizers,
      (SELECT COUNT(*)::int FROM gigs       WHERE artist_id = ${artist.id}) AS gigs,
      (SELECT COUNT(*)::int FROM setlists   WHERE artist_id = ${artist.id}) AS setlists,
      (SELECT COUNT(*)::int FROM song_logs  WHERE artist_id = ${artist.id}) AS logs,
      (SELECT COUNT(*)::int FROM gema_works WHERE artist_id = ${artist.id}) AS gema_works
  `;

  console.log(`\n${B('Done.')} ${D(`— artist: ${artist.name}`)}`);
  console.log(D('─'.repeat(44)));
  console.log(`  Songs       ${B(stats.songs)}  (${songRows.filter(r => !r.active).length} inactive)`);
  console.log(`  Venues      ${B(stats.venues)}`);
  console.log(`  Organizers  ${B(stats.organizers)}`);
  console.log(`  Gigs        ${B(stats.gigs)}`);
  console.log(`  Setlists    ${B(stats.setlists)}`);
  console.log(`  Log rows    ${B(stats.logs)}`);
  console.log(`  GEMA        ${B(stats.gema_works)} works\n`);
}

run()
  .catch(e => { err(e.message); process.exitCode = 1; })
  .finally(() => sql.end());
