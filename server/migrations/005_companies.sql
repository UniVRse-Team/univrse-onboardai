-- Companies (multi-company tenants, issue #86). Every account except a platform
-- administrator belongs to exactly one company; departments and the audit trail
-- are per company. Everything that existed before belongs to the default
-- company, UniVRse (server/companies.mjs DEFAULT_COMPANY_ID = 'univrse').
-- Additive: the column defaults keep code from before #86 working against a
-- migrated database (its inserts land in UniVRse). Applied once by
-- `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,30}[a-z0-9]$'),
  name text NOT NULL CHECK (name ~ '^.{1,80}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  default_hr_account_id uuid,
  -- The company profile (server/company-profile.mjs): company facts, never
  -- personal data. Kept here so a save and its audit row commit together.
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  profile_version integer NOT NULL DEFAULT 0 CHECK (profile_version >= 0),
  profile_updated_at timestamptz,
  profile_updated_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES accounts (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_lower_key ON companies (lower(name));
INSERT INTO companies (id, name) VALUES ('univrse', 'UniVRse') ON CONFLICT DO NOTHING;

-- Accounts: the platform administrator role, and the company of every other
-- account (admin <=> no company).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'univrse' REFERENCES companies (id);
UPDATE accounts SET company_id = 'univrse' WHERE company_id IS NULL;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_role_check CHECK (role IN ('admin', 'hr', 'employee'));
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_company_role_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_company_role_check
  CHECK ((role = 'admin' AND company_id IS NULL) OR (role <> 'admin' AND company_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS accounts_company_role ON accounts (company_id, role);

-- The company's default HR (its HR contact; "Ask HR" requests are assigned to
-- it). UniVRse's is its oldest HR account, when there is one.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_default_hr_fkey;
ALTER TABLE companies ADD CONSTRAINT companies_default_hr_fkey
  FOREIGN KEY (default_hr_account_id) REFERENCES accounts (id) ON DELETE SET NULL;
UPDATE companies SET default_hr_account_id = (
  SELECT id FROM accounts WHERE role = 'hr' AND company_id = 'univrse'
  ORDER BY created_at, lower(username) LIMIT 1)
WHERE id = 'univrse' AND default_hr_account_id IS NULL;

-- Departments per company: a name and a prefix are unique within a company.
-- Employee IDs stay unique everywhere: employee_id_counters is still counted
-- per prefix across all companies.
ALTER TABLE departments ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT 'univrse' REFERENCES companies (id);
UPDATE departments SET company_id = 'univrse';
DROP INDEX IF EXISTS departments_name_lower_key;
DROP INDEX IF EXISTS departments_prefix_key;
CREATE UNIQUE INDEX IF NOT EXISTS departments_company_name_key ON departments (company_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS departments_company_prefix_key ON departments (company_id, prefix);

-- The company an audit row concerns (NULL: a platform event such as admin_created).
ALTER TABLE account_events ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'univrse' REFERENCES companies (id);
UPDATE account_events SET company_id = 'univrse' WHERE company_id IS NULL;
CREATE INDEX IF NOT EXISTS account_events_company ON account_events (company_id, created_at);
