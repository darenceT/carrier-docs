import type { BrowserContext } from 'patchright';

/**
 * The context's storage state (cookies, local storage), ready to be encrypted and saved so a
 * repeat run can skip login and MFA. The result is secret: never log it.
 */
export async function exportStorageState(context: BrowserContext): Promise<unknown> {
  return context.storageState();
}
