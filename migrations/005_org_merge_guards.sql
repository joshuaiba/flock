-- 005_org_merge_guards: an organization can never be merged into itself.
--
-- merge() locks both rows and re-checks them, so this should be unreachable;
-- the constraint makes a self-reference (the start of a merged_into cycle,
-- which would leave a group of rows with no live member) impossible to store.
-- Guarded so a partial manual apply can be re-run, like 004.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'organizations_not_merged_into_self'
          AND conrelid = 'organizations'::regclass
    ) THEN
        ALTER TABLE organizations
            ADD CONSTRAINT organizations_not_merged_into_self
            CHECK (merged_into IS NULL OR merged_into <> id);
    END IF;
END
$$;
