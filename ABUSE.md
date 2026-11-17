# Abuse policy — Klausum OTP

## Not allowed
- Sending codes nobody asked for, or to numbers/emails you don't have permission to contact.
- "SMS pumping", toll fraud, or flooding someone with codes (harassment).
- Using codes or the message text for anything but verification (ads, links, phishing).
- Trying to get around rate limits, caps or the throwaway-email check (rotating IPs, many keys, etc.).
- Testing attacks against the hosted service without written permission (security reports welcome — see below).

## What we do
Automatic: per-person, per-IP and per-app limits; an alert to the operator when sends jump to 5× normal.
Then, depending on what we see, without notice:
1. block the phone number, email, email domain or IP (`blocklist`);
2. lower the app's daily cap or **pause** the app;
3. **revoke** the API key, and refuse new keys for that developer.

## Report abuse or a security problem
Email **support@klausum.study** with the time, the number/email that received unwanted codes (or a
masked form), and any request ID. Security issues: please give us a reasonable time to fix them before
sharing publicly. We don't take legal action against good-faith security research.
