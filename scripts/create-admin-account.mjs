// npm run admin:create: creates a platform administrator account.
// Input rules are in hr-account-tool.mjs: terminal prompts without echo, or
// piped lines (Admin ID, password, password again); never arguments.
//
//   printf '%s\n%s\n%s\n' admin "$PASSWORD" "$PASSWORD" | npm run admin:create
//
// The new account has role 'admin' and belongs to no company.
import { createAdminAccount, runHrCommand } from './hr-account-tool.mjs';

await runHrCommand({
  command: 'admin:create',
  action: createAdminAccount,
  idLabel: 'Admin ID',
  passwordLabel: 'Password',
});
