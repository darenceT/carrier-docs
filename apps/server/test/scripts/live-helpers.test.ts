import { describe, expect, it } from 'vitest';
import {
  StepTimer,
  detectBlock,
  formatSteps,
  isPdf,
  looksLikeBadCredentials,
  maskUrl,
} from '../../src/scripts/live/helpers.js';

describe('detectBlock', () => {
  it('finds block pages, challenges and challenge frames', () => {
    expect(detectBlock('Access Denied. Reference #18.abc')).toBe('CARRIER_BLOCKED');
    expect(detectBlock('Sorry, you have been blocked')).toBe('CARRIER_BLOCKED');
    expect(detectBlock('Verify you are human by completing the action below')).toBe(
      'CARRIER_CHALLENGE',
    );
    expect(detectBlock('Checking if the site connection is secure')).toBe('CARRIER_CHALLENGE');
    expect(detectBlock('Sign in', ['https://challenges.cloudflare.com/cdn-cgi/x'])).toBe(
      'CARRIER_CHALLENGE',
    );
  });

  it('prefers a block over a challenge, and returns null on a normal page', () => {
    expect(detectBlock('unusual traffic... access denied')).toBe('CARRIER_BLOCKED');
    expect(
      detectBlock('Welcome back. Enter your email.', ['https://www.lemonade.com/']),
    ).toBeNull();
  });
});

describe('looksLikeBadCredentials', () => {
  it('recognises common wrong-credential messages', () => {
    expect(looksLikeBadCredentials('The username or password is incorrect')).toBe(true);
    expect(looksLikeBadCredentials("We couldn't find an account with that email")).toBe(true);
    expect(looksLikeBadCredentials('Enter the code we sent')).toBe(false);
  });
});

describe('maskUrl', () => {
  it('keeps host and path, masks IDs, and drops query and fragment', () => {
    expect(
      maskUrl('https://api.progressive.com/policypro/v1/policies/123456/document?k=secret'),
    ).toBe('api.progressive.com/policypro/<id>/policies/<id>/document');
    expect(maskUrl('https://icebox.lemonade.com/tokens/abcdefghijklmnopqrstuvwxyz0123#x')).toBe(
      'icebox.lemonade.com/tokens/<id>',
    );
    expect(maskUrl('not a url')).toBe('<unparseable url>');
  });
});

describe('StepTimer', () => {
  it('records step durations and excludes skipped human waits', () => {
    let t = 1000;
    const timer = new StepTimer(() => t);
    t += 800;
    timer.mark('login page');
    t += 30_000; // a person typing a code
    timer.skip();
    t += 500;
    timer.mark('code accepted');
    expect(timer.steps).toEqual([
      { name: 'login page', ms: 800 },
      { name: 'code accepted', ms: 500 },
    ]);
    expect(timer.machineMs).toBe(1300);
    expect(formatSteps(timer.steps)).toContain('1300 ms');
  });
});

describe('isPdf', () => {
  it('checks the PDF magic bytes', () => {
    expect(isPdf(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true);
    expect(isPdf(new TextEncoder().encode('<html>'))).toBe(false);
  });
});
