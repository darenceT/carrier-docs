import { blockRules as demoBlockRules, paths as demoPaths } from '../carriers/demo/selectors.js';
import type { CanaryCarrier } from '../infra/config.js';
import type { CanaryTarget } from './canary.js';

/**
 * Public login pages, as recorded in docs/spike.md. The canary only loads these; it never
 * submits a form.
 */
export const CARRIER_LOGIN_URLS = {
  progressive: 'https://account.apps.progressive.com/access/login?cntgrp=A&fd=accountHome',
  lemonade: 'https://www.lemonade.com/login#email',
} as const;

export interface TargetOptions {
  carriers: CanaryCarrier[];
  /** The mock portal's base URL, when the Demo carrier is enabled. */
  demoBaseUrl?: string;
}

export function canaryTargets({ carriers, demoBaseUrl }: TargetOptions): CanaryTarget[] {
  return carriers.flatMap((id): CanaryTarget[] => {
    if (id === 'demo') {
      return demoBaseUrl
        ? [
            {
              carrierId: 'demo',
              loginUrl: `${demoBaseUrl}${demoPaths.login}`,
              rules: demoBlockRules,
            },
          ]
        : [];
    }
    return [{ carrierId: id, loginUrl: CARRIER_LOGIN_URLS[id] }];
  });
}
