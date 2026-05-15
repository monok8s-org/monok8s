-- Creates additional databases needed by platform services.
-- The default 'monok8s' database is created via POSTGRES_DB env var.
CREATE DATABASE zitadel;
CREATE DATABASE temporal;
CREATE DATABASE temporal_visibility;
