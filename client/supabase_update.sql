-- =========================================================
-- Alchymista Hra - Supabase Aktualizace pro herní smyčku (Ruská ruleta)
-- Spusťte tento skript v Supabase Dashboard -> SQL Editor
-- =========================================================

ALTER TABLE public.rooms 
ADD COLUMN IF NOT EXISTS game_status TEXT DEFAULT 'waiting',
ADD COLUMN IF NOT EXISTS deck JSONB,
ADD COLUMN IF NOT EXISTS current_turn_player_id INT8;

ALTER TABLE public.room_players 
ADD COLUMN IF NOT EXISTS is_dead BOOLEAN DEFAULT FALSE;
