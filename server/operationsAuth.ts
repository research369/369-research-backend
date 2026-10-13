import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { orderHash } from './jarvyOrderContract.js';
export const actorSchema = z.object({ id: z.string().uuid(), username: z.string().min(1).max(100), role: z.enum(['viewer', 'operator', 'admin']) }).strict();
export type OpsActor = z.infer<typeof actorSchema>;
const assertionSchema = z.object({ actor: actorSchema, issuedAt: z.number().int(), method: z.string(), path: z.string(), bodyHash: z.string().length(64) }).strict();
export function verifyOperationsActor(header: string | undefined, method: string, path: string, body: unknown, key = process.env.OPS_CONSOLE_KEY, now = Date.now()): OpsActor | null {
    if (!key || key.length < 48 || !header?.startsWith('Bearer ') || header.length > 4096)
        return null;
    try {
        const parts = header.slice(7).split('.');
        if (parts.length !== 2)
            return null;
        const [payload, signature] = parts;
        const expected = createHmac('sha256', key).update(payload).digest();
        const received = Buffer.from(signature, 'base64url');
        if (received.length !== expected.length || !timingSafeEqual(received, expected))
            return null;
        const a = assertionSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
        if (a.method !== method || a.path !== path || a.bodyHash !== orderHash(body ?? null) || now - a.issuedAt > 30000 || a.issuedAt - now > 5000)
            return null;
        return a.actor;
    }
    catch {
        return null;
    }
}
