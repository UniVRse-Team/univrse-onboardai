// Shared by npm run hr:create and npm run hr:reset-password.
//
// In a terminal they ask for the HR ID and the password twice; the password is
// not shown. Piped input is read as lines (HR ID, password, and optionally the
// password again), so they can be scripted:
//
//   printf '%s\n%s\n%s\n' HR-0001 "$PASSWORD" "$PASSWORD" | npm run hr:create
//
// A password is never accepted as a command-line argument, and it is never
// printed or logged. HR accounts made or reset here have no forced change.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createAccountStore, createDatabasePool } from '../server/account-store.mjs';
import { usernamePattern } from '../server/account-service.mjs';
import { hashPassword, passwordProblem } from '../server/password-hashing.mjs';

const databaseHelp =
  'Check that the database is running (npm run db:up) and migrated (npm run db:migrate).';

// Terminal prompts. While `hidden` is set, typed characters are not echoed.
function prompter(stdin, stdout) {
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!hidden) stdout.write(chunk, encoding);
      done();
    },
  });
  const lines = createInterface({ input: stdin, output, terminal: true });
  lines.on('SIGINT', () => {
    stdout.write('\n');
    process.exit(130);
  });
  return {
    ask(question, { secret = false } = {}) {
      return new Promise((resolve) => {
        stdout.write(question);
        hidden = secret;
        lines.question('', (answer) => {
          hidden = false;
          if (secret) stdout.write('\n');
          resolve(answer);
        });
      });
    },
    close: () => lines.close(),
  };
}

// Piped lines: HR ID, password, and optionally the password again.
export function parsePipedInput(text) {
  const [username = '', password = '', confirmation] = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  return {
    username,
    password,
    confirmation: confirmation === undefined || confirmation === '' ? password : confirmation,
  };
}

export async function readHrCredentials({
  stdin = process.stdin,
  stdout = process.stdout,
  idLabel = 'HR ID',
  passwordLabel = 'Password',
} = {}) {
  if (stdin.isTTY) {
    const terminal = prompter(stdin, stdout);
    const username = await terminal.ask(`${idLabel}: `);
    const password = await terminal.ask(`${passwordLabel}: `, { secret: true });
    const confirmation = await terminal.ask(`${passwordLabel} again: `, { secret: true });
    terminal.close();
    return { username, password, confirmation };
  }
  let text = '';
  for await (const chunk of stdin) {
    text += chunk;
    if (text.length > 4096) throw new Error('The piped input is too long.');
  }
  return parsePipedInput(text);
}

// The same rules as the API: the ID format and the password rules. Returns the
// trimmed ID, or throws an Error whose message is safe to print.
export function checkHrCredentials({ username, password, confirmation }) {
  const id = String(username || '').trim();
  if (!usernamePattern.test(id))
    throw new Error('Use an ID of 3 to 32 letters, numbers, dots, hyphens or underscores.');
  const problem = passwordProblem(password, id);
  if (problem) throw new Error(problem);
  if (password !== confirmation) throw new Error('The two passwords do not match.');
  return id;
}

// Each returns { ok, message }; the message never contains the password.
export async function createHrAccount(
  store,
  entered,
  { hash = hashPassword, at = new Date() } = {},
) {
  const username = checkHrCredentials(entered);
  try {
    const account = await store.createAccount({
      username,
      passwordHash: await hash(entered.password),
      role: 'hr',
      mustChangePassword: false,
      createdBy: null,
      action: 'hr_account_created',
      at,
    });
    return { ok: true, message: `Created HR account ${account.username} (${account.id}).` };
  } catch (error) {
    if (error.code === 'USERNAME_TAKEN')
      return { ok: false, message: 'That HR ID is already in use.' };
    return { ok: false, message: `The HR account could not be created. ${databaseHelp}` };
  }
}

export async function resetHrAccountPassword(
  store,
  entered,
  { hash = hashPassword, at = new Date() } = {},
) {
  const username = checkHrCredentials(entered);
  try {
    const account = await store.resetHrPassword(username, await hash(entered.password), at);
    if (!account) return { ok: false, message: 'No HR account with that ID.' };
    return {
      ok: true,
      message: `Reset the password for HR account ${account.username}. Its sessions have ended and any lock is cleared.`,
    };
  } catch {
    return { ok: false, message: `The password could not be reset. ${databaseHelp}` };
  }
}

export async function createAdminAccount(
  store,
  entered,
  { hash = hashPassword, at = new Date() } = {},
) {
  const username = checkHrCredentials(entered);
  try {
    const account = await store.createAccount({
      username,
      passwordHash: await hash(entered.password),
      role: 'admin',
      mustChangePassword: false,
      createdBy: null,
      action: 'admin_created',
      at,
      companyId: null,
    });
    return { ok: true, message: `Created Admin account ${account.username} (${account.id}).` };
  } catch (error) {
    if (error.code === 'USERNAME_TAKEN')
      return { ok: false, message: 'That Admin ID is already in use.' };
    return { ok: false, message: `The Admin account could not be created. ${databaseHelp}` };
  }
}

export async function resetAdminAccountPassword(
  store,
  entered,
  { hash = hashPassword, at = new Date() } = {},
) {
  const username = checkHrCredentials(entered);
  try {
    const account = await store.resetHrPassword(username, await hash(entered.password), at, {
      role: 'admin',
    });
    if (!account) return { ok: false, message: 'No Admin account with that ID.' };
    return {
      ok: true,
      message: `Reset the password for Admin account ${account.username}. Its sessions have ended and any lock is cleared.`,
    };
  } catch {
    return { ok: false, message: `The password could not be reset. ${databaseHelp}` };
  }
}

// The command-line flow shared by both scripts.
export async function runHrCommand({
  command,
  action,
  idLabel = 'HR ID',
  passwordLabel = 'Password',
}) {
  const stop = (message) => {
    console.error(message);
    process.exit(1);
  };
  if (process.argv.length > 2)
    stop(
      `npm run ${command} takes no arguments. It asks for the ID and password, or reads them from piped input.`,
    );
  if (existsSync('.env')) process.loadEnvFile('.env');
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) stop('Set DATABASE_URL in .env first (see .env.example).');
  let entered;
  try {
    entered = await readHrCredentials({ idLabel, passwordLabel });
    checkHrCredentials(entered);
  } catch (error) {
    stop(error.message);
  }
  const store = createAccountStore({ pool: createDatabasePool(databaseUrl), log: () => {} });
  try {
    const result = await action(store, entered);
    if (result.ok) console.log(result.message);
    else {
      console.error(result.message);
      process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}
