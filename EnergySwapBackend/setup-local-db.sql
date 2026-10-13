-- EnergySwap local database bootstrap (safe to re-run).
--
-- Creates the application role and its database. Idempotent.
--
-- The password is supplied as a psql variable so it is never stored in this
-- file or left in shell history:
--   psql -U postgres -h localhost -v app_password='...' -f setup-local-db.sql
--
-- NOTE: psql does NOT interpolate :variables inside dollar-quoted blocks,
-- so the conditional DDL below uses SELECT ... \gexec instead of DO/\$\$.
--
-- The matching connection string belongs in .env (gitignored):
--   DATABASE_URL=postgresql://energyswap:<password>@localhost:5432/energyswap

-- 1. Create the login role if it does not exist yet.
SELECT 'CREATE ROLE energyswap LOGIN PASSWORD ' || quote_literal(:'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'energyswap')
\gexec

-- 2. Always set the password, so re-runs converge on the value in .env.
SELECT 'ALTER ROLE energyswap LOGIN PASSWORD ' || quote_literal(:'app_password')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'energyswap')
\gexec

-- 3. Create the database if it does not exist yet.
SELECT 'CREATE DATABASE energyswap OWNER energyswap'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'energyswap')
\gexec

-- 4. Grant the role access to its own database.
GRANT ALL PRIVILEGES ON DATABASE energyswap TO energyswap;