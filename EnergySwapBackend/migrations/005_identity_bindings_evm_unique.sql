-- Make the identity binding relation genuinely one-to-one.
--
-- Migration 004 created a plain index on evm_address, which allowed a single
-- EVM wallet to hold several settlement accounts at once. That is the
-- balance-splitting pattern the table's own comment says the UNIQUE constraint
-- on hedera_account_id exists to prevent: park one wallet across N accounts and
-- any per-account limit is multiplied by N.
--
-- This is a separate file rather than an edit to 004 because the migrator keys
-- on filename and skips anything already recorded in schema_migrations. Editing
-- an applied migration is a silent no-op - the statement never runs, and the
-- protection described in the comment is simply absent from every database that
-- already applied 004. Migrations are immutable; corrections ship as new files.

-- Deduplicate before enforcing. CREATE UNIQUE INDEX fails outright if duplicate
-- rows exist, which would abort the whole migration and leave the deploy stuck.
-- Where one identity claimed several accounts, keep the most recently created
-- row: it is the binding the user made last, and therefore the one they expect
-- to remain in force.
DELETE FROM identity_bindings a
      USING identity_bindings b
      WHERE a.evm_address = b.evm_address
        AND a.hedera_account_id <> b.hedera_account_id
        AND (a.created_at, a.hedera_account_id) < (b.created_at, b.hedera_account_id);

-- A unique index also serves the lookup by evm_address, so the plain index from
-- 004 is dropped rather than left to duplicate its work on every write.
DROP INDEX IF EXISTS identity_bindings_evm_idx;

CREATE UNIQUE INDEX IF NOT EXISTS identity_bindings_evm_unique
    ON identity_bindings (evm_address);