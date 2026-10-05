'use strict';

// Writable fields of the CRM records, for parseFields (api/_validate.js).
// Create and update use the same table, so they cannot drift apart again.
// Lengths match the bulk-edit limits in api/_band/venues.js.

const { F, jsonBytes } = require('../_validate');

// Free-form JSON (social links, extra) per record.
const JSON_MAX = 16 * 1024;

const link = () => F.url(500, { addScheme: true });

const VENUE_FIELDS = {
  name:                    F.text(200, { required: true }),
  street_number:           F.text(20),
  street:                  F.text(300),
  postcode:                F.text(20),
  city:                    F.text(200),
  state:                   F.text(100),
  country:                 F.text(100),
  category:                F.text(100),
  status:                  F.text(50),
  comment:                 F.text(2000),
  phone:                   F.text(100),
  contact_name:            F.text(200),
  generic_email:           F.text(254),
  website:                 link(),
  social_links:            F.object({ nullable: false, maxBytes: JSON_MAX }),
  alive:                   F.bool(),
  activated:               F.bool(),
  declined:                F.bool(),
  overnight:               F.bool(),
  heart:                   F.bool(),
  last_communication:      F.date(),
  deadline:                F.date(),
  booking_channel:         F.text(50),
  number_of_cold_contacts: F.int(0, 100000, { nullable: false }),
  turnus:                  F.text(100),
  remuneration:            F.text(100),
  season:                  F.text(50),
  preferred_period:        F.text(100),
  main_genre:              F.text(100),
  size:                    F.int(0, 10000000),
  language:                F.text(20),
  lat:                     F.num(-90, 90),
  lng:                     F.num(-180, 180),
};

const ORGANIZER_FIELDS = {
  name:               F.text(200, { required: true }),
  type:               F.text(50),
  email:              F.text(254),
  phone:              F.text(100),
  website:            link(),
  social_links:       F.object({ nullable: false, maxBytes: JSON_MAX }),
  city:               F.text(200),
  country:            F.text(100),
  last_communication: F.date(),
  comment:            F.text(2000),
  extra:              F.object({ nullable: false, maxBytes: JSON_MAX }),
  heart:              F.bool(),
};

const GIG_FIELDS = {
  title:           F.text(200, { required: true }),
  date:            F.date(),
  venue_id:        F.int(1, 2147483647),
  organizer_id:    F.int(1, 2147483647),
  type:            F.text(100),
  time_start:      F.time(),
  time_end:        F.time(),
  additional_link: link(),
  additional_text: F.text(2000),
  comment:         F.text(2000),
  location:        F.text(200),
};

// The SET clause of a record update, keyword included: plain columns as sent,
// and the JSONB columns in `jsonKeys` merged into the stored object in SQL
// (`social_links = social_links || $patch`), not read, merged in JS and
// written whole: an edit saved meanwhile is no longer lost. Always sets
// last_updated = NOW(). (One `col = $n` fragment per column: sql(object)
// only builds a SET list right after the word `update` in the same fragment.)
function updateSet(sql, value, jsonKeys) {
  let set = sql`last_updated = NOW()`;
  for (const [k, v] of Object.entries(value)) {
    if (!jsonKeys.includes(k)) set = sql`${sql(k)} = ${v}, ${set}`;
    else if (v) set = sql`${sql(k)} = ${sql(k)} || ${v}::jsonb, ${set}`;
  }
  return sql`SET ${set}`;
}

// Would merging `value`'s JSONB keys into `stored` push one past maxBytes? Each
// request is capped, but merges add up; the stored object ships with every row.
function mergedTooLarge(value, stored, keys, maxBytes = JSON_MAX) {
  for (const k of keys) {
    if (value[k] && jsonBytes({ ...(stored[k] || {}), ...value[k] }) > maxBytes) return k;
  }
  return null;
}

module.exports = { VENUE_FIELDS, ORGANIZER_FIELDS, GIG_FIELDS, updateSet, mergedTooLarge };
