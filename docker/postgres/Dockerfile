# PostgreSQL 16 with PostGIS (from the base image) and pgvector (from the PostgreSQL apt repository),
# both enabled in the application database by the init script.
FROM postgis/postgis:16-3.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
COPY initdb/10-extensions.sql /docker-entrypoint-initdb.d/20-admiralty-extensions.sql
