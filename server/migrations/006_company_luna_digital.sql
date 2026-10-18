-- Migration 006: Rebrand default tenant from 'univrse' to 'luna-digital' (Luna Digital).
-- Updates companies table, migrates accounts, departments, and account_events,
-- and updates column defaults to 'luna-digital'. Safe to re-run.

-- 1. If any company other than 'luna-digital' already has the name 'Luna Digital' (case-insensitive),
-- rename it temporarily so it does not collide with the unique index companies_name_lower_key.
UPDATE companies
SET name = 'Luna Digital (' || id || ')'
WHERE lower(name) = 'luna digital' AND id <> 'luna-digital';

-- 2. Upsert 'luna-digital' company
INSERT INTO companies (id, name, status, created_at, updated_at)
VALUES ('luna-digital', 'Luna Digital', 'active', now(), now())
ON CONFLICT (id) DO UPDATE SET name = 'Luna Digital';

-- 3. If 'univrse' company exists, copy its profile and default HR to 'luna-digital'
UPDATE companies
SET profile = CASE WHEN companies.profile = '{}'::jsonb THEN u.profile ELSE companies.profile END,
    profile_version = CASE WHEN companies.profile_version = 0 THEN u.profile_version ELSE companies.profile_version END,
    profile_updated_at = COALESCE(companies.profile_updated_at, u.profile_updated_at),
    profile_updated_by = COALESCE(companies.profile_updated_by, u.profile_updated_by),
    default_hr_account_id = COALESCE(companies.default_hr_account_id, u.default_hr_account_id)
FROM (SELECT * FROM companies WHERE id = 'univrse') u
WHERE companies.id = 'luna-digital';

-- 4. If any legacy alias company exists (like 'luna-didital'), copy its profile/HR if still empty
UPDATE companies
SET profile = CASE WHEN companies.profile = '{}'::jsonb THEN d.profile ELSE companies.profile END,
    profile_version = CASE WHEN companies.profile_version = 0 THEN d.profile_version ELSE companies.profile_version END,
    profile_updated_at = COALESCE(companies.profile_updated_at, d.profile_updated_at),
    profile_updated_by = COALESCE(companies.profile_updated_by, d.profile_updated_by),
    default_hr_account_id = COALESCE(companies.default_hr_account_id, d.default_hr_account_id)
FROM (SELECT * FROM companies WHERE id = 'luna-didital') d
WHERE companies.id = 'luna-digital';

-- 5. Repoint accounts and account_events from legacy tenants to 'luna-digital'
UPDATE accounts SET company_id = 'luna-digital' WHERE company_id IN ('univrse', 'luna-didital');
UPDATE account_events SET company_id = 'luna-digital' WHERE company_id IN ('univrse', 'luna-didital');

-- 6. Avoid duplicate department prefix or name when migrating to 'luna-digital'
DELETE FROM departments
WHERE company_id IN ('univrse', 'luna-didital')
  AND (
    prefix IN (SELECT prefix FROM departments WHERE company_id = 'luna-digital')
    OR lower(name) IN (SELECT lower(name) FROM departments WHERE company_id = 'luna-digital')
  );

-- Repoint remaining departments from legacy tenants to 'luna-digital'
UPDATE departments SET company_id = 'luna-digital' WHERE company_id IN ('univrse', 'luna-didital');

-- 7. Remove old companies if present
DELETE FROM companies WHERE id IN ('univrse', 'luna-didital');

-- 8. Update column defaults to 'luna-digital'
ALTER TABLE accounts ALTER COLUMN company_id SET DEFAULT 'luna-digital';
ALTER TABLE departments ALTER COLUMN company_id SET DEFAULT 'luna-digital';
ALTER TABLE account_events ALTER COLUMN company_id SET DEFAULT 'luna-digital';
