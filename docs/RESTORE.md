# Restoring the database

Two safety nets:

1. **D1 Time Travel** (built in, free): restore the database to **any minute in the last 7 days**. Fastest.
2. **Weekly encrypted backups** (GitHub Actions → *Backup*, Sundays 02:00 UTC, kept 90 days) for anything older.

> A restore only changes the **database**. Secrets (keys, pepper…) are not in it and stay as they are.
> Codes in flight at the restore point are useless anyway (5-minute life).

## A. Time Travel (last 7 days)

```bash
# 1. See what you can restore to
npx wrangler d1 time-travel info klausum-otp
# 2. Restore to a moment (UTC) — or use --bookmark from step 1
npx wrangler d1 time-travel restore klausum-otp --timestamp=2026-11-17T12:00:00Z
```
Wrangler prints a bookmark for the state *before* the restore, so you can undo it with
`--bookmark=<that value>`.

## B. From an encrypted weekly backup

1. GitHub → **Actions → Backup** → open a run → download the artifact (a `.zip` holding
   `klausum-otp-YYYY-MM-DD.sql.gz.enc`).
2. Decrypt with the passphrase from `.secrets.local` (`BACKUP_PASSPHRASE`):
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in klausum-otp-YYYY-MM-DD.sql.gz.enc -out db.sql.gz -pass pass:YOUR_PASSPHRASE
   gunzip db.sql.gz
   ```
   (Windows: run these in **Git Bash**, which includes openssl.)
3. **Practise on staging first:**
   ```bash
   npx wrangler d1 execute klausum-otp-staging --remote --env staging --command "DROP TABLE IF EXISTS d1_migrations"
   npx wrangler d1 execute klausum-otp-staging --remote --env staging --file db.sql
   ```
   Then check https://otp-staging.klausum.study/health and log in to the staging admin.
4. For production, restore into a **new** database and switch to it (safer than overwriting):
   ```bash
   npx wrangler d1 create klausum-otp-restored
   npx wrangler d1 execute klausum-otp-restored --remote --file db.sql
   # put the new database_id into wrangler.jsonc (top-level d1_databases), commit, push → CI deploys
   ```
5. Delete the decrypted `db.sql` afterwards.

## Practice
Do a practice restore into **staging** every 6 months (see MAINTENANCE.md). Note the date here:

| Date | What | Result |
|---|---|---|
| | | |
