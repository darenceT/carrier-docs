/**
 * Where a session's traffic leaves from (design D3). The same egress is used for the whole
 * session: an IP change mid-session can void it or re-trigger MFA.
 */
export interface EgressProxy {
  server: string;
  username?: string;
  password?: string;
}

export interface EgressProvider {
  readonly kind: 'direct' | 'proxy';
  /** Proxy settings for a new browser context, or undefined to go out directly. */
  proxy(): EgressProxy | undefined;
}

/** Render's own IP. The spike loaded both carriers' login pages clean from it. */
export const directEgress: EgressProvider = { kind: 'direct', proxy: () => undefined };

/**
 * A pay-as-you-go proxy, only if direct gets blocked. The URL may carry credentials
 * (`http://user:pass@host:port`); they are split out for the browser and never logged.
 */
export function proxyEgress(url: string): EgressProvider {
  const parsed = new URL(url);
  const proxy: EgressProxy = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return { kind: 'proxy', proxy: () => ({ ...proxy }) };
}

export function createEgress(proxyUrl: string | undefined): EgressProvider {
  return proxyUrl ? proxyEgress(proxyUrl) : directEgress;
}
