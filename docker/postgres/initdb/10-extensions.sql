-- Runs once, when the data directory is first initialised. The server also issues these on start-up,
-- so an existing volume created without them is covered too.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
