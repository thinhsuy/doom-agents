-- 042_agent_body_override.sql — let the owner edit an agent's persona (knowledge/skills)
-- from the console. The .md file stays the source-of-truth base; an edit is stored HERE as
-- an override so it (a) survives redeploy — build.py's DO UPDATE never touches this column —
-- and (b) takes effect immediately: the responder/worker prefer body_override over the file.
-- NULL = no override (use the repo .md as before).
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS body_override text;
