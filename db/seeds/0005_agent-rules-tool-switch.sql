-- B3-08m: the switch of the Agent tool search_rules (08 BR-AI-02 细则「开关」: MVP 工具默认 on;
-- 04 §10.2). search_rules joins the production stream assembly in B3-08m; without this row the
-- registry reads the switch as off and a fresh database starts with rule search disabled.
-- Synthetic app_id only. agent.rag.min_score (code default 0.2, BR-AI-07 细则「T6 与其他」) and the
-- P1 / read-only earnings tool switches are not seeded.
-- Re-runnable: ON CONFLICT DO NOTHING keeps every existing value and revision, including a switch
-- an operator turned off. Uses only INSERT, so it also runs as couli_app.

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  ('couli', 'agent.tools.search_rules.enabled', 'true'::jsonb, 'seed') -- BR-AI-02 细则
ON CONFLICT (app_id, key) DO NOTHING;
