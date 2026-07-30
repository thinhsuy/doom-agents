-- 020_owner_actor.sql — attribute owner-sent chat messages to WHICH owner (CEO/CTO/COO).
-- Owner messages are stored with from_agent NULL; this column records the acting owner's
-- role so the chat shows a clear identity instead of a generic "CEO / CTO". Existing
-- owner messages are backfilled to 'CEO' (owner's call); new sends record the logged-in
-- account. Agent-sent messages (from_agent NOT NULL) keep owner_actor NULL.
ALTER TABLE company.messages ADD COLUMN IF NOT EXISTS owner_actor text;

UPDATE company.messages
   SET owner_actor = 'CEO'
 WHERE from_agent IS NULL AND owner_actor IS NULL;
