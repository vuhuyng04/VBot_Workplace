-- VBot schema. Every user-owned row carries user_id; Row-Level Security enforces it for the
-- (application role). Statements are separated by a line holding only the split marker (two dashes, two semicolons).
CREATE EXTENSION IF NOT EXISTS vector;
--;;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--;;
CREATE TABLE IF NOT EXISTS users (
  user_id     text PRIMARY KEY,
  email       text NOT NULL,
  department  text NOT NULL DEFAULT 'default',
  role        text NOT NULL DEFAULT 'user',
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE INDEX IF NOT EXISTS conversations_user ON conversations (user_id, updated_at DESC);
--;;
CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         text NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  tier            text,
  model           text,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric(12, 6),
  created_at      timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, created_at);
--;;
CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  source      text NOT NULL,           -- upload | gdrive | gmail | agent
  s3_key      text,
  title       text NOT NULL,
  acl         text[] NOT NULL DEFAULT '{}', -- principals allowed by the source system (besides owner)
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE IF NOT EXISTS chunks (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  ord         int NOT NULL,
  content     text NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding   halfvec(512)
);
--;;
CREATE INDEX IF NOT EXISTS chunks_user ON chunks (user_id);
--;;
CREATE INDEX IF NOT EXISTS chunks_tsv ON chunks USING gin (tsv);
--;;
CREATE INDEX IF NOT EXISTS chunks_vec ON chunks USING hnsw (embedding halfvec_cosine_ops);
--;;
CREATE TABLE IF NOT EXISTS memories (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE IF NOT EXISTS agent_runs (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  goal        text NOT NULL,
  status      text NOT NULL,           -- planning | awaiting_confirmation | running | done | rejected | failed
  plan        jsonb,
  result      text,
  task_token  text,
  execution_arn text,
  cost_usd    numeric(12, 6) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--;;
CREATE TABLE IF NOT EXISTS connector_accounts (
  user_id     text NOT NULL,
  connector   text NOT NULL,
  account     text,
  scopes      text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connector)
);
--;;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vbot_app') THEN
    CREATE ROLE vbot_app LOGIN;
  END IF;
END $$;
--;;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, conversations, messages, documents, chunks, memories, agent_runs, connector_accounts TO vbot_app;
--;;
GRANT USAGE, SELECT ON SEQUENCE chunks_id_seq TO vbot_app;
--;;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','messages','documents','chunks','memories','agent_runs','connector_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS owner_only ON %I', t);
    EXECUTE format($p$CREATE POLICY owner_only ON %I TO vbot_app
      USING (user_id = current_setting('app.user_id', true))
      WITH CHECK (user_id = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;
--;;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--;;
DROP POLICY IF EXISTS self_only ON users;
--;;
CREATE POLICY self_only ON users TO vbot_app
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
