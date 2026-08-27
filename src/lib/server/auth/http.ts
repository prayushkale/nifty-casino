/**
 * Response helpers shared by the `/api/auth/*` routes.
 *
 * Two rules the whole folder obeys:
 *
 *  1. **Unconfigured auth is a 400, never a 500.** `AUTH_NOT_CONFIGURED` is a
 *     contract the UI checks for, because "no Supabase project" is a supported
 *     state of this app, not an outage.
 *  2. **Supabase errors are relayed, not re-thrown.** The auth server's own
 *     message ("User already registered", rate limits) is exactly what the form
 *     needs to show, and its status is already client-appropriate.
 */
import { json } from '@sveltejs/kit';

/** The error code the UI treats as "show the dev-auth panel instead". */
export const AUTH_NOT_CONFIGURED = 'AUTH_NOT_CONFIGURED';

export function authNotConfigured(): Response {
	return json({ error: AUTH_NOT_CONFIGURED }, { status: 400 });
}

/** Field-level validation failure — `{ error, fields }`, always 400. */
export function validationFailed(fields: Record<string, string>): Response {
	return json({ error: 'VALIDATION_FAILED', fields }, { status: 400 });
}

/** Parse a JSON object body, or `null` when it is absent/malformed/not an object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await request.json();
		if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
		return body as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Relay a Supabase auth failure to the client. The status is clamped into
 * 4xx — a 5xx from the auth server would read as *our* server being broken,
 * which it is not, and a missing status is by far the common case.
 */
export function supabaseErrorResponse(err: unknown): Response {
	const status =
		typeof (err as { status?: unknown } | null)?.status === 'number'
			? ((err as { status: number }).status ?? 400)
			: 400;
	const clamped = status >= 400 && status < 500 ? status : 400;
	const message =
		err instanceof Error && err.message.trim() !== '' ? err.message : 'Authentication failed.';
	return json({ error: message }, { status: clamped });
}
