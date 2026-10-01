'use strict';

// Writable fields of the CRM records, for parseFields (api/_validate.js).
// Create and update use the same table, so they cannot drift apart again.
// Lengths match the bulk-edit limits in venues.js.

const { F } = require('../_validate');

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

// JSONB fields an update merges into the stored object instead of replacing.
function mergeJson(value, stored, keys) {
  for (const k of keys) if (value[k]) value[k] = { ...(stored[k] || {}), ...value[k] };
  return value;
}

module.exports = { VENUE_FIELDS, ORGANIZER_FIELDS, GIG_FIELDS, mergeJson };
