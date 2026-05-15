-- users_find_by_id — bench script for the users.findById query shape.
--
-- Mirrors packages/db/src/index.ts::users.findById:
--     SELECT * FROM users WHERE id = $1
--
-- Phase B (#189 / #166). Second bench target demonstrating that the
-- pattern generalizes across tables. The launcher seeds the
-- canonical bench tenant (FK target) + 10K users including one with
-- the canonical bench user id so every iteration hits the index path
-- against a populated table.

SELECT * FROM users WHERE id = '00000000-0000-0000-0000-000000000002'::uuid;
