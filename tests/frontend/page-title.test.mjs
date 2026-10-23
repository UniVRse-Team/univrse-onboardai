import test from 'node:test';
import assert from 'node:assert/strict';
import { pageTitle, companyNameFromId } from '../../src/portal/page-title.mjs';
import { navigation } from '../../src/portal/website-content.js';

const employee = { role: 'employee', company: { name: 'Luna Digital' } };
const nav = (path) => navigation.find((n) => n.path === path) || null;

test('tenant paths show Welcome with the company name', () => {
  assert.equal(pageTitle({ path: '/companies/luna-digital' }), 'Welcome · Luna Digital');
  assert.equal(pageTitle({ path: '/companies/luna-digital/login' }), 'Welcome · Luna Digital');
  assert.equal(
    pageTitle({ path: '/companies/luna-digital', tenantName: 'Luna Digital Pte' }),
    'Welcome · Luna Digital Pte',
  );
});

test('companyNameFromId humanises ids', () => {
  assert.equal(companyNameFromId('luna-digital'), 'Luna Digital');
  assert.equal(companyNameFromId(null), '');
});

test('access pages', () => {
  assert.equal(pageTitle({ path: '/login' }), 'Welcome · OnboardAi');
  assert.equal(pageTitle({ path: '/' }), 'Welcome · OnboardAi');
  assert.equal(pageTitle({ path: '/signup' }), 'Create an employee account · OnboardAi');
  assert.equal(pageTitle({ path: '/hr/luna-digital' }), 'HR workspace · OnboardAi');
  assert.equal(pageTitle({ path: '/admin' }), 'Platform Admin · OnboardAi');
  assert.equal(pageTitle({ path: '/admin/companies/luna-digital' }), 'Platform Admin · OnboardAi');
});

test('employee pages use the company brand', () => {
  assert.equal(
    pageTitle({ path: '/alya', account: employee, active: nav('/alya') }),
    'Ask Alya · Luna Digital',
  );
  assert.equal(
    pageTitle({ path: '/onboarding', account: employee, active: nav('/onboarding') }),
    'My onboarding · Luna Digital',
  );
  assert.equal(
    pageTitle({ path: '/onboarding/some-activity', account: employee, active: nav('/onboarding') }),
    'My onboarding · Luna Digital',
  );
  assert.equal(
    pageTitle({ path: '/profile', account: employee, active: { label: 'My profile' } }),
    'My profile · Luna Digital',
  );
});

test('change-password screen and unknown paths', () => {
  assert.equal(
    pageTitle({ path: '/onboarding', account: employee, changePassword: true }),
    'Change your password · Luna Digital',
  );
  assert.equal(pageTitle({ path: '/nope', account: employee }), 'Page not found · Luna Digital');
});
