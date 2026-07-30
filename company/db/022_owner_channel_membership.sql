-- 022_owner_channel_membership.sql — per-owner channel visibility. An owner sees a group
-- chat only if they're a MEMBER (like a normal chat app); open channels with no member
-- list (ch-general "Toàn công ty", engagement channels) stay visible to everyone.
-- Backfill: CEO is a member of every PRE-EXISTING group (topic channel that already has
-- members) so the CEO keeps seeing all prior groups. CTO/COO see a group only once added.
-- ch-general (0 members) is intentionally NOT touched — it must stay open to all owners.
INSERT INTO company.channel_members (channel_id, agent)
SELECT ch.id, 'ceo'
FROM company.channels ch
WHERE ch.kind = 'topic'
  AND EXISTS (SELECT 1 FROM company.channel_members cm WHERE cm.channel_id = ch.id)
ON CONFLICT DO NOTHING;
