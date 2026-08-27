/**
 * Signup request validator — pure, so it is unit-tested and shared by the
 * `/api/auth/signup` route with no store, no Supabase and no network.
 *
 * One deliberate asymmetry with the database trigger (0002): an *invalid*
 * handle is a 400 here, not a silent fallback. The trigger runs inside
 * `auth.users` where there is nobody to ask, so it silently generates; an
 * interactive form can and should tell the player their name is unusable.
 * An *absent* handle (`undefined`, `null`, `''`, whitespace) stays a generate,
 * in both places.
 */
import { HANDLE_RULE, sanitizeHandle } from './handles';

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Deliberately loose: it is a shape check, not a deliverability check. Supabase
 * is the authority on whether an address is real — it will refuse or bounce it.
 * We only need to reject obvious junk before paying for an auth round trip.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FieldErrors = Partial<Record<'email' | 'password' | 'tos' | 'handle', string>>;

export type SignupValue = {
	email: string;
	password: string;
	/** `null` → generate one. */
	handle: string | null;
};

export type SignupValidation =
	| { ok: true; value: SignupValue }
	| { ok: false; fieldErrors: FieldErrors };

/** Non-blank string, normalized (trimmed + lowercased email). `null` when unusable. */
export function readEmail(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const email = raw.trim().toLowerCase();
	return EMAIL_PATTERN.test(email) ? email : null;
}

/** The password as given, or `''` when it is too short / not a string at all. */
export function readPassword(raw: unknown): string {
	return typeof raw === 'string' && raw.length >= MIN_PASSWORD_LENGTH ? raw : '';
}

/** Error message, or `null` when the password is acceptable. */
export function readPasswordError(raw: unknown): string | null {
	if (typeof raw !== 'string' || raw.length < MIN_PASSWORD_LENGTH) {
		return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	return null;
}

/** The sanitized handle, `null` when the player skipped it, or an error message. */
export function readHandle(raw: unknown): { handle: string | null } | { error: string } {
	// Skipped is not the same as invalid: nothing to say about an empty field.
	if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
		return { handle: null };
	}
	const handle = sanitizeHandle(raw);
	if (!handle) return { error: `Handles use ${HANDLE_RULE}` };
	return { handle };
}

/** `true` only for an explicit, real boolean — `"true"` from a JSON body is not consent. */
export function readTos(raw: unknown): boolean {
	return raw === true;
}

/**
 * Validate a signup body. Everything it needs comes in as `unknown`: the JSON
 * body of the request, already parsed but otherwise untrusted.
 */
export function validateSignupRequest(body: unknown): SignupValidation {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, fieldErrors: { email: EMAIL_REQUIRED } };
	}

	const fields = body as Record<string, unknown>;
	const fieldErrors: FieldErrors = {};

	const email = readEmail(fields.email);
	if (!email) fieldErrors.email = EMAIL_REQUIRED;

	const password = readPassword(fields.password);
	if (password === '') fieldErrors.password = PASSWORD_TOO_SHORT;

	if (!readTos(fields.tos)) fieldErrors.tos = TOS_REQUIRED;

	const handle = readHandle(fields.handle);
	if ('error' in handle) fieldErrors.handle = handle.error;

	// Report every bad field at once — a form should be able to mark them all.
	if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

	// Reaching this return *is* the proof the fields are well-formed, so the
	// re-read of the email keeps the types honest without a cast.
	return {
		ok: true,
		value: {
			email: readEmail(fields.email) ?? '',
			password,
			handle: 'error' in handle ? null : handle.handle
		}
	};
}

const EMAIL_REQUIRED = 'Enter a valid email address.';
const PASSWORD_TOO_SHORT = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
const TOS_REQUIRED = 'Please confirm you are 18+ and accept the play-money terms.';
