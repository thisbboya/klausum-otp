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
3. **Load it into a fresh database** (the export contains `CREATE TABLE`, so it must go into an
   empty one — never into a database that already has the tables):
   ```bash
   npx wrangler d1 create klausum-otp-restored
   npx wrangler d1 execute klausum-otp-restored --remote --file db.sql -y
   ```
4. **Check it** against what you expect (compare with production if it's still readable):
   ```bash
   npx wrangler d1 execute klausum-otp-restored --remote --command "SELECT (SELECT COUNT(*) FROM apps) apps,(SELECT COUNT(*) FROM api_keys) keys,(SELECT COUNT(*) FROM totp_secrets) totp,(SELECT COUNT(*) FROM d1_migrations) migrations"
   ```
5. **Switch production to it:** in `wrangler.jsonc` (top-level `d1_databases`) set `database_name` to
   `klausum-otp-restored` and `database_id` to the new id; in `.github/workflows/deploy.yml` change the
   migrations line to `klausum-otp-restored`. Commit and push → CI applies any migrations newer than the
   backup, then deploys. Check https://otp.klausum.study/health and log in to the control room.
6. Delete the decrypted `db.sql` afterwards. Keep the old database for a week, then delete it.

## Practice
Do a practice restore every 6 months (see MAINTENANCE.md): steps 1–4 into a throwaway database,
compare, then `npx wrangler d1 delete <name> -y`.

| Date | What | Result |
|---|---|---|
| 2026-11-17 | Downloaded the first weekly backup from GitHub (59 824 bytes), decrypted with `BACKUP_PASSPHRASE`, loaded into a throwaway D1, compared with production, deleted it | ✅ 10 tables, 1 196 rows; apps 4, keys 3, logs 18, stats 9, TOTP 2 — identical to production (production had 2 newer migrations, applied after the backup) |
