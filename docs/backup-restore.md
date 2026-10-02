# Backups and restore

What protects each production deployment's data, how to set it up once, and
the exact steps to get data back. Development databases and buckets hold test
data and are not backed up.

---

## What is protected

| Layer | Covers | How far back | Restore takes |
|---|---|---|---|
| **Neon history** (point-in-time restore) | every write to each production database | the project's restore window (below) | minutes |
| **Nightly dump** (`.github/workflows/backup.yml`) | each production database, encrypted, stored outside Neon | 30 days | under an hour |
| **Upload mirror** (same workflow) | every object in each upload bucket; deleted or replaced objects are kept | 30 days after they left the bucket | minutes |

Neon's restore window depends on the plan and is set per project: at the time
of writing 6 hours on Free, up to 7 days on Launch, up to 30 days on Scale.
Check it in each project's settings; it is the most useful number on this page.

**Worst case:** inside the restore window, nothing is lost. Outside it, up to a
day of writes (since the last nightly dump) and up to a day of uploads.

Not backed up here, so keep your own copy (a password manager is fine):

- each Vercel project's environment variables (`vercel env pull` into a file,
  store it, delete the file); losing `APP_SECRET` logs everyone out,
- the age private key (below). Without it the dumps are unreadable, to you too.

Each nightly dump is **restored into a scratch Postgres and compared with the
source** (every table's row count, sequence positions, schema version) before
it is encrypted and kept. A dump that does not restore fails the run.

---

## One-time setup

### 1. Encryption key

On your own machine:

```bash
age-keygen -o smartist-backup.key      # prints "Public key: age1…"
```

Store `smartist-backup.key` in two places (password manager and an offline
copy), then delete it from disk. The private key never goes to GitHub or
Cloudflare. The public key goes into the repository **variable**
`BACKUP_AGE_RECIPIENT` (Settings → Secrets and variables → Actions → Variables).

### 2. Backup bucket

Cloudflare → R2 → **Create bucket**, e.g. `smartist-backups`. No public access.
Then its Settings → **Object lifecycle rules**:

| Rule | Prefix | Action |
|---|---|---|
| Expire dumps | `db/` | delete objects 30 days after upload |
| Expire deleted files | `deleted-files/` | delete objects 30 days after upload |

Leave `files/` without a rule: it is the live mirror.

Optional, stronger: a **bucket lock** rule on `db/` for 7 days. A leaked
backup token then cannot delete recent dumps.

The lifecycle keeps deleting while nothing new arrives, so a backup that
stops for 30 days leaves nothing. The heartbeat (step 5) is what tells you.

### 3. Two R2 API tokens

R2 → Manage R2 API Tokens → Create:

| Token | Permission | Buckets | Secrets |
|---|---|---|---|
| backup writer | Object Read & Write | the backup bucket only | `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` |
| upload reader | Object Read only | every production upload bucket | `BACKUP_SOURCE_R2_ACCESS_KEY_ID`, `BACKUP_SOURCE_R2_SECRET_ACCESS_KEY` |

Also add the secrets `BACKUP_R2_ACCOUNT_ID` (the Cloudflare account ID) and
`BACKUP_R2_BUCKET` (the backup bucket's name). The workflow assumes the upload
buckets and the backup bucket are in the same Cloudflare account.

### 4. What to back up

Two repository **secrets**, one line each per production deployment,
`<label> <value>`:

```text
BACKUP_DATABASES          BACKUP_FILE_BUCKETS
db1 postgresql://…        files1 <bucket name>
db2 postgresql://…        files2 <bucket name>
```

- **Labels appear in the public Actions logs and in backup paths**: keep them
  neutral (`db1`, not a band's name) and write down privately which is which.
- Use each Neon project's **direct** connection string (host without
  `-pooler`); the script switches a pooled one to direct anyway.
- Better than the owner's string: a read-only role. In the Neon console create
  a role `backup` on the production branch, then in the SQL editor:
  `GRANT pg_read_all_data TO backup;`. If Neon refuses the grant, use the
  owner's string.
- A new deployment adds a line to both secrets (`tenant-onboarding.md`).

### 5. Heartbeat

Better Stack → Uptime → **Heartbeats** → new heartbeat, expected every
1 day, grace period 3 hours. Put its URL in the secret `BACKUP_HEARTBEAT_URL`.
Each successful run pings it, a failed run pings `<url>/fail`. It alerts on
what a red run cannot show: GitHub **disables schedules** in a repository with
no activity for 60 days, and a disabled schedule sends nothing.

### 6. First run

Actions → **Nightly backups** → Run workflow. Then in the backup bucket:
`db/<label>/<date>/` holds a `.dump.age` and a `.manifest.json` per database,
`files/<label>/` a copy of each upload bucket. Then do the drill below once:
it proves the private key opens the dumps.

---

## Tools on your machine

```bash
sudo port install age rclone postgresql17     # MacPorts
export PG_BIN=/opt/local/lib/postgresql17/bin  # fish: set -x PG_BIN /opt/local/lib/postgresql17/bin
```

`pg_restore` must be the dumps' major version or newer (the workflow's
`PG_MAJOR`, 17 today).

Two rclone remotes, one per token (the values from the Cloudflare dashboard):

```bash
rclone config create smartist-backups s3 provider=Cloudflare no_check_bucket=true \
  endpoint=https://<account id>.r2.cloudflarestorage.com \
  access_key_id=<backup writer id> secret_access_key=<backup writer secret>
rclone config create smartist-media s3 provider=Cloudflare no_check_bucket=true \
  endpoint=https://<account id>.r2.cloudflarestorage.com \
  access_key_id=<the deployment's R2_ACCESS_KEY_ID> secret_access_key=<its R2_SECRET_ACCESS_KEY>
```

`smartist-media` needs write access to put files back, so it uses the
deployment's own R2 token (from its Vercel environment variables), not the
read-only backup reader.

---

## Which restore?

| What happened | Go to |
|---|---|
| One song or its lyrics/arrangement changed or deleted | the app itself: song change log → restore |
| Bad data or a bad script, inside the restore window | **A. Point-in-time restore** |
| Same, but only one band in a database several bands share | **B. One band from a restore branch** |
| Outside the restore window, or the Neon project is gone | **C. From a nightly dump** |
| A file deleted or broken | **D. One file** |
| A whole upload bucket lost | **E. A whole bucket** |

After A, B or C, always do **F** (files) and **G** (erased accounts).

### A. Point-in-time restore (Neon)

Rolls **the whole database** back, every band in it.

1. Pick the moment **T** (UTC) just before the damage: the Better Stack logs,
   `song_logs`, or when the script ran.
2. Look before you restore. Neon console → the project → Branches → **Create
   branch** from `main`, "past point in time" T, name it `inspect-<date>`.
   Connect to it (its own connection string, or the SQL editor) and check the
   data is what you want.
3. Restore: Branches → `main` → **Restore** → from history, time T. Neon keeps
   the state it replaces as a backup branch. The connection string does not
   change, so no Vercel change is needed. CLI equivalent:
   `neon branches restore main ^self@<T> --preserve-under-name main_before_restore`
4. If T is before the last schema migration, **redeploy production**
   (`vercel redeploy <the production URL>`): the build applies the schema
   again. Then `GET https://<domain>/api/config?action=health` must say
   `"schema":"current"`.
5. Do F and G with this T.
6. After a week, delete `inspect-…` and the backup branch (branches count
   against the plan's limit).

### B. One band from a restore branch

A shared database holds several bands; rolling it back would undo everyone
else's work since T. Instead:

1. Create an `inspect-<date>` branch at T (A.2).
2. Copy that band's rows from the branch into production by hand, table by
   table, with `artist_id = <id>`. Try the whole copy on a second branch of
   *current* production first, then run it for real.

This is case by case; if it gets complicated, restoring the whole database
(A) and telling the other bands may be the honest option.

### C. From a nightly dump

1. Download the dump and its manifest (or use the R2 dashboard):
   ```bash
   rclone copy smartist-backups:<backup bucket>/db/<label>/<date> ./restore
   ```
2. Create a **new, empty** database: a new Neon project in the same region
   (production branch), or a new branch with no data. Copy its direct
   connection string.
3. Restore and check it:
   ```bash
   DATABASE_URL='<new direct string>' node scripts/db_restore.js \
     --dump ./restore/<label>-<stamp>.dump.age --identity <path to smartist-backup.key>
   ```
   It verifies the checksum, refuses a database that already has tables,
   restores in one transaction and compares the result with the manifest.
4. Point the deployment at it: follow **Rotating a database connection
   string** in [`deployment.md`](deployment.md) (every Vercel environment,
   `DEMO_DATABASE_URL` where it applies, and the line in `BACKUP_DATABASES`),
   then redeploy. The build brings the schema up to date; check the health
   endpoint.
5. Do F and G with T = the manifest's `createdAt`.
6. Remove the plaintext and decrypted files from `./restore`.

### D. One file

Find the file's key (the part of its URL after the bucket's public URL, from
the song, gig or band settings, or the song change log). Then:

```bash
# still in the bucket's mirror?
rclone ls smartist-backups:<backup bucket>/files/<label>/<key>
# or removed on some day:
rclone ls smartist-backups:<backup bucket>/deleted-files/<label>/ --include '**/<file name>'
rclone copyto smartist-backups:<backup bucket>/<where it was found> smartist-media:<upload bucket>/<key>
```

Same key, same URL: the song or gig shows it again at once. Then
`node scripts/plans.js --recount` against that database, so storage usage
counts it.

### E. A whole bucket

1. Create the new bucket (public access, CORS) as in
   [`tenant-onboarding.md`](tenant-onboarding.md).
2. `rclone copy smartist-backups:<backup bucket>/files/<label> smartist-media:<new bucket>`
3. Stored file URLs are absolute (`songs.extra` listenUrl/sheetUrl/playbackUrl,
   `gigs.poster_url`/`thumb_url`, `artists.config` logoUrl/faviconUrl). With a
   **custom domain**, attach it to the new bucket and nothing else changes.
   With an `r2.dev` URL the new bucket gets a new one, and every stored URL
   needs rewriting: prefer moving to a custom domain first.
4. Update `R2_BUCKET_NAME` (and `R2_PUBLIC_URL` if it changed) on the Vercel
   project, the line in `BACKUP_FILE_BUCKETS`, redeploy.

### F. Files after a database restore

Rows restored to T can point at files deleted after T. Files never disappear
from the mirror silently: they move to `deleted-files/<label>/<day>/`. Put back
everything removed since T's day (files that nothing references cost storage
and nothing else):

```bash
rclone copy smartist-backups:<backup bucket>/deleted-files/<label>/<day> smartist-media:<upload bucket>
# once per day from T's date to today, then:
node scripts/plans.js --recount
```

A file deleted within the last day, before the next mirror, is not in the
backup.

### G. Erased accounts after a restore

A restore to T brings back every account deleted after T. Erasure must stick:
find the deletions since T (the `account_deleted` log lines; Better Stack
keeps logs 3 days, so keep your own list of erasure requests with their dates)
and delete those accounts again. Dumps expire after 30 days, which is the
retention the privacy page states.

---

## Drill (every three months, and after changing any of the setup)

1. Download last night's dump of one database and restore it locally:
   ```bash
   npm run dev:up                                    # local Postgres on :5433
   createdb -h localhost -p 5433 -U postgres drill
   DATABASE_URL=postgres://postgres@localhost:5433/drill node scripts/db_restore.js \
     --dump ./restore/<file>.dump.age --identity <key>
   dropdb -h localhost -p 5433 -U postgres drill
   ```
   Proves the key opens the dumps; the nightly run proves the rest.
2. Neon: create a branch from an hour ago, query it, delete it.
3. Put one file back from `files/` into a dev bucket (D).
4. Write down the date and how long each step took.

---

## Before anything risky

Before a release with a schema change, or a data script against production:

- write down the UTC time: it is your restore point T (A),
- if the change is large, take a dump as well; it only reads the database and
  asks first:
  ```bash
  DATABASE_URL='<production direct string>' node scripts/db_backup.js --label db1 --out ./backups \
    --recipient <your age public key>
  ```
  (`./backups` is git-ignored. Without `--recipient` the dump is plaintext
  personal data: delete it when done.)
