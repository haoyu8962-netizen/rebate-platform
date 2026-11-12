-- B1-22z: the switch of the Agent tool get_my_earnings (08 BR-AI-02 细则「开关」: MVP 工具默认 on;
-- 04 §10.2 agent.tools.<name>.enabled 默认 on, get_my_earnings included per D32). Without this row
-- the registry reads the switch as off and a fresh database starts with the earnings tool disabled.
-- Synthetic app_id only. The P1 tool switches (create_watch / list_watches / cancel_watch) are not
-- seeded.
-- Re-runnable: ON CONFLICT DO NOTHING keeps every existing value and revision, including a switch
-- an operator turned off. Uses only INSERT, so it also runs as couli_app.

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  ('couli', 'agent.tools.get_my_earnings.enabled', 'true'::jsonb, 'seed') -- BR-AI-02 细则
ON CONFLICT (app_id, key) DO NOTHING;
