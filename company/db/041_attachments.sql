-- 041_attachments.sql — image attachments for Team Chat. Stored as bytea IN Postgres
-- (not S3) so it works identically local + cloud with no extra IAM/serving; the chat poll
-- stays light because the bytes are fetched only when an <img> renders, never in /api/chat.
-- Referenced from messages.payload->'attachments' = [{id,name,mime}]. Bounded by an app-side
-- size cap. Doc tags reuse messages.payload->'docRefs' = ["Folder/name.md", …] (no table).
CREATE TABLE IF NOT EXISTS company.attachments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mime       text NOT NULL,
  name       text,
  data       bytea NOT NULL,
  size       int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
