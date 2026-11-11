/**
 * Every URL and selector the Demo adapter uses, in one place (the same layout every carrier
 * follows). The Demo carrier is the mock portal in packages/mock-portal.
 */
export const paths = {
  login: '/login',
  mfa: '/mfa',
  dashboard: '/dashboard',
  documentsApi: '/api/documents',
} as const;

export const selectors = {
  login: {
    form: '#login-form',
    username: '#username',
    password: '#password',
    submit: '#login-submit',
  },
  mfa: {
    form: '#mfa-form',
    hint: '#mfa-hint',
    code: '#code',
    remember: '#remember',
    submit: '#mfa-submit',
    lockout: '#lockout',
  },
  error: '#error',
  dashboard: { policies: '#policies' },
} as const;

/** What the portal's own pages say, for the BlockDetector. */
export const blockRules = {
  badCredentials: [/invalid username or password/i],
  blocked: [/reference #\S+\.demo/i],
};
