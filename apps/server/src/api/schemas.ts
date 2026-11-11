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

export const startSessionSchema = z.strictObject({
  carrierId,
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  prewarmSessionId: id.optional(),
});

export const mfaSchema = z.strictObject({ code: z.string().regex(/^\d{4,10}$/) });

export const sessionParams = z.object({ sessionId: id });

export const documentParams = z.object({ sessionId: id, docId: id });
