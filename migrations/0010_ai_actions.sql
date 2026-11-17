-- Audit log of every action the assistant took or proposed.
CREATE TABLE ai_actions (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  args_json   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('done','failed','pending_approval','approved','cancelled')),
  result_json TEXT,
  source      TEXT NOT NULL,          -- 'chat' | 'self-check'
  decided_at  INTEGER
);
CREATE INDEX idx_ai_actions_created ON ai_actions(created_at);
