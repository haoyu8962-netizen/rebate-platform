-- B1-22za: the Agent master switches (08 BR-AI-12 细则「/v1/config.agent.enabled 的派生」: agent.enabled
-- and agent.page_guide.enabled 默认 on 由种子写入; 负责人 2026-11-12 选 A, Q-A14, D10-1333). Without
-- these rows the runtime reads both switches as off.
-- Not a public opening: agent.whitelist_only stays unseeded (missing reads as on) and the internal
-- test list agent.whitelist_user_ids has no seed, so it is empty until filled in the admin (BR-AI-12).
-- Synthetic app_id only.
-- Re-runnable: ON CONFLICT DO NOTHING keeps every existing value and revision, including a switch
-- an operator turned off. Uses only INSERT, so it also runs as couli_app.

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  ('couli', 'agent.enabled', 'true'::jsonb, 'seed'), -- BR-AI-12 细则
  ('couli', 'agent.page_guide.enabled', 'true'::jsonb, 'seed') -- BR-AI-12 细则, BR-AI-01 细则「页面引导」
ON CONFLICT (app_id, key) DO NOTHING;
