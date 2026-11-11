/** HTML templates for the mock portal. Only plain server-rendered pages; no scripts. */
import { MOCK_INSURED_NAME, type MockDocument, type MockPolicy } from './data.js';

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Demo Insurance (test fixture)</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  .banner { background: #fff3cd; border: 1px solid #e0c36c; padding: .5rem .75rem; font-size: .875rem; }
  .error { color: #a40000; font-weight: 600; }
  label { display: block; margin-top: .75rem; }
  input[type=text], input[type=password] { width: 100%; padding: .4rem; box-sizing: border-box; }
  button { margin-top: 1rem; padding: .5rem 1rem; }
</style>
</head>
<body>
<p class="banner">DEMO INSURANCE: a test fixture, not a real insurance company. All data is fake.</p>
${body}
</body>
</html>
`;
}

function errorBlock(message: string | undefined): string {
  return message ? `<p class="error" id="error" role="alert">${message}</p>\n` : '';
}

export function loginPage(opts: {
  base: string;
  formToken: string;
  error?: string;
  username?: string;
}): string {
  return page(
    'Sign in',
    `<h1>Sign in</h1>
${errorBlock(opts.error)}<form id="login-form" method="post" action="${opts.base}/login">
  <input type="hidden" id="form-token" name="formToken" value="${opts.formToken}">
  <label for="username">Username</label>
  <input type="text" id="username" name="username" autocomplete="username" value="${escapeHtml(opts.username ?? '')}">
  <label for="password">Password</label>
  <input type="password" id="password" name="password" autocomplete="current-password">
  <button type="submit" id="login-submit">Sign in</button>
</form>`,
  );
}

export function blockedPage(): string {
  return page(
    'Access Denied',
    `<h1>Access Denied</h1>
<p>You don't have permission to access this page on this server.</p>
<p id="reference">Reference #18.demo</p>`,
  );
}

export function mfaPage(opts: { base: string; error?: string }): string {
  return page(
    'Verify your identity',
    `<h1>Verify your identity</h1>
<p id="mfa-hint">We sent a code to •••-•••-1234</p>
${errorBlock(opts.error)}<form id="mfa-form" method="post" action="${opts.base}/mfa">
  <label for="code">Verification code</label>
  <input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
  <label><input type="checkbox" id="remember" name="remember" value="on"> Remember this device</label>
  <button type="submit" id="mfa-submit">Verify</button>
</form>`,
  );
}

export function tooManyAttemptsPage(base: string): string {
  return page(
    'Too many attempts',
    `<h1>Too many attempts</h1>
<p id="lockout">Too many attempts. For your security, please sign in again.</p>
<p><a href="${base}/login">Back to sign in</a></p>`,
  );
}

export function dashboardPage(opts: {
  base: string;
  policies: readonly MockPolicy[];
  documents: readonly MockDocument[];
}): string {
  const items = opts.policies
    .map((policy) => {
      const docs = opts.documents
        .filter((d) => d.policyNumber === policy.policyNumber)
        .map(
          (d) =>
            `      <li><a class="document-link" data-document-id="${d.id}" href="${opts.base}/api/documents/${d.id}/download">${d.title}</a></li>`,
        )
        .join('\n');
      return `  <li class="policy" data-policy-id="${policy.id}">
    <h2>${policy.line} policy ${policy.policyNumber}</h2>
    <p>${policy.description}</p>
    <ul>
${docs}
    </ul>
  </li>`;
    })
    .join('\n');
  return page(
    'Your policies',
    `<h1>Your policies</h1>
<p id="welcome">Welcome back, ${MOCK_INSURED_NAME}.</p>
<ul id="policies">
${items}
</ul>
<form id="logout-form" method="post" action="${opts.base}/logout">
  <button type="submit" id="logout">Sign out</button>
</form>`,
  );
}
