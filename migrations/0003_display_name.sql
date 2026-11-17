-- Human name used in emails/SMS ("Your Klausum code: 482913").
ALTER TABLE apps ADD COLUMN display_name TEXT;
UPDATE apps SET display_name = 'Klausum' WHERE name = 'klausum-web';
UPDATE apps SET display_name = 'Meraaba' WHERE name = 'meraaba';
