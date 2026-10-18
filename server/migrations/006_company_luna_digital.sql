-- Migration 006: Rebrand default tenant from 'univrse' to 'luna-digital' (Luna Digital).
-- Updates companies table, migrates accounts, departments, and account_events,
-- and updates column defaults to 'luna-digital'. Safe to re-run.

INSERT INTO companies (id, name, status, created_at, updated_at)
VALUES ('luna-digital', 'Luna Digital', 'active', now(), now())
ON CONFLICT (id) DO UPDATE SET name = 'Luna Digital';

-- If 'univrse' company exists, copy its profile and default HR to 'luna-digital'
UPDATE companies
SET profile = u.profile,
    profile_version = u.profile_version,
    profile_updated_at = u.profile_updated_at,
    profile_updated_by = u.profile_updated_by,
    default_hr_account_id = COALESCE(companies.default_hr_account_id, u.default_hr_account_id)
FROM (SELECT * FROM companies WHERE id = 'univrse') u
WHERE companies.id = 'luna-digital';

-- Repoint foreign keys from 'univrse' to 'luna-digital'
UPDATE accounts SET company_id = 'luna-digital' WHERE company_id = 'univrse';
UPDATE departments SET company_id = 'luna-digital' WHERE company_id = 'univrse';
UPDATE account_events SET company_id = 'luna-digital' WHERE company_id = 'univrse';

-- Remove old 'univrse' company if present
DELETE FROM companies WHERE id = 'univrse';

-- Update column defaults to 'luna-digital'
ALTER TABLE accounts ALTER COLUMN company_id SET DEFAULT 'luna-digital';
ALTER TABLE departments ALTER COLUMN company_id SET DEFAULT 'luna-digital';
ALTER TABLE account_events ALTER COLUMN company_id SET DEFAULT 'luna-digital';
