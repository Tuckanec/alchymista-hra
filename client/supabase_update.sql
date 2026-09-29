ALTER TABLE room_players ADD COLUMN IF NOT EXISTS hand jsonb DEFAULT '[]'::jsonb;
