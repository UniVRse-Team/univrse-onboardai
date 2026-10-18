// npm run admin:reset-password: recovers an administrator account without editing
// the database directly. Input rules are in hr-account-tool.mjs: terminal prompts
// without echo, or piped lines (Admin ID, new password, new password again);
// never arguments.
//
//   printf '%s\n%s\n%s\n' admin "$PASSWORD" "$PASSWORD" | npm run admin:reset-password
import { resetAdminAccountPassword, runHrCommand } from './hr-account-tool.mjs';

await runHrCommand({
  command: 'admin:reset-password',
  action: resetAdminAccountPassword,
  idLabel: 'Admin ID',
  passwordLabel: 'New password',
});
