import type { LoginField } from '@carrier-docs/contracts';
import { z } from 'zod';

/** Request validation. Strict objects: unknown keys are rejected, not silently dropped. */

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const carrierId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);

export const accessSchema = z.strictObject({ code: z.string().min(1).max(256) });

export const prewarmSchema = z.strictObject({ carrierId });

/** Only the carrier ID, read first to find which login fields that carrier declares. */
export const startSessionCarrierSchema = z.object({ carrierId });

const loginField: Record<LoginField, z.ZodType<string>> = {
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  email: z.email().max(256),
};

/**
 * The full login body for one carrier: exactly its declared fields, each required. A field the
 * carrier doesn't use (a password for an email-only carrier) is an unknown key, so it's rejected.
 */
export function startSessionSchema(fields: readonly LoginField[]) {
  return z.strictObject({
    carrierId,
    prewarmSessionId: id.optional(),
    ...Object.fromEntries(fields.map((f) => [f, loginField[f]])),
  });
}

export const mfaSchema = z.strictObject({ code: z.string().regex(/^\d{4,10}$/) });

export const sessionParams = z.object({ sessionId: id });

export const documentParams = z.object({ sessionId: id, docId: id });
