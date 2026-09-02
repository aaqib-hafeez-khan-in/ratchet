-- A provider quota is a temporary condition, and until now it was fatal.
--
-- Resend's daily quota resets at UTC midnight. The retry ladder tops out at 30
-- minutes and gives up after 5 attempts, so every message queued while the quota
-- was spent died inside an hour — including the welcome mail that carries a new
-- customer's verification link. Three died this way on 2 Sep 2026; all three were
-- probe signups rather than customers, which was luck, not design.
--
-- Deferrals are counted separately from attempts because they are not delivery
-- attempts: nothing was offered to the recipient, we simply had no budget to
-- offer it with. Counting them apart lets a message wait out several quota days
-- without burning the retries it needs for real transport failures, while still
-- bounding how long we hold a message nobody has read.
ALTER TABLE email_messages ADD COLUMN deferrals INT NOT NULL DEFAULT 0;

CREATE INDEX email_messages_deferred_idx ON email_messages (next_attempt_at)
  WHERE state = 'queued' AND deferrals > 0;
