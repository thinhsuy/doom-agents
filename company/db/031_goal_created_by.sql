-- 031_goal_created_by.sql — track WHO created each goal ("Mục tiêu" card) for easier
-- management. Seeded goals stay NULL = shown as 'hệ thống'. Set going forward by
-- POST /api/goals (the logged-in owner's username). Distinct from `owner` (the agent
-- responsible for the goal).
ALTER TABLE company.goals ADD COLUMN IF NOT EXISTS created_by text;
