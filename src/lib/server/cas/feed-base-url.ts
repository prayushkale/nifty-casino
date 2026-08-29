/**
 * Upstream feed base URLs — the seam that lets a relay (or a local mitm proxy)
 * front NSE/BSE with no code change.
 *
 * WHY IT EXISTS: PLAN §6 R1 is the deployment's one make-or-break unknown. NSE and
 * BSE front their public APIs with Akamai, which scores the *calling IP*, and a
 * datacenter IP (EC2) is routinely served a 403/Access-Denied challenge that a
 * residential IP sails through. When the Task 3.5 spike shows the VM is blocked,
 * the fix is a residential-egress relay, and the relay is chosen with env vars:
 *
 *   NSE_BASE_URL=http://<relay>:8081      BSE_BASE_URL=http://<relay>:8081
 *
 * SEMANTICS (identical for both variables):
 *
 *  • unset / empty / whitespace-only → the hard-coded literal upstream, i.e. today's
 *    behaviour bit for bit. Production is unchanged unless an operator opts in.
 *  • trailing slashes are trimmed, so `${base}${path}` can never produce a `//`.
 *  • read per request, never cached at import — a restart to pick up new env is the
 *    only ceremony, and a test can flip the value mid-run.
 *  • anything without an `http://` / `https://` scheme throws {@link FeedBaseUrlError}
 *    instead of falling back. That is deliberate: a typo'd override that silently
 *    reverted to the real NSE would keep production talking to a blocked IP while
 *    the runbook insists the relay is live. Throwing surfaces it in the poller log
 *    (`[cas-poller] NSE E1 failed: …`) and turns the watchdog red within minutes.
 *
 * WHAT AN OVERRIDE DOES **NOT** CHANGE — and must not:
 *
 *  • the paths and query strings, including NSE's literal `&&` in the E1 URL;
 *  • the browser-like headers and the no-Cookie rule (both upstreams' Akamai rules);
 *  • the `Origin`/`Referer` values, which stay pinned to the real origins. Akamai
 *    validates them against the Host it thinks it is serving, and a relay rewrites
 *    Host on the way out — so the header must keep naming the real site even though
 *    the TCP connection now points elsewhere.
 *
 * Server-only, like everything else under `$lib/server`: the override names an
 * internal address, and it must never reach a browser bundle.
 */

/** Env var that re-points every NSE request (Akamai warm-up + E1 + E3). */
export const NSE_BASE_URL_ENV = 'NSE_BASE_URL';

/** Env var that re-points the BSE `GetSensexDatanew` call. */
export const BSE_BASE_URL_ENV = 'BSE_BASE_URL';

/** Thrown when an override is set but not a usable http(s) origin. */
export class FeedBaseUrlError extends Error {
	constructor(envVar: string, value: string) {
		super(
			`${envVar} must be an http:// or https:// origin (no path needed) — got "${value}". ` +
				'Fix the variable or unset it to talk to the real upstream.'
		);
		this.name = 'FeedBaseUrlError';
	}
}

/**
 * Resolve one feed base URL. Pure — callers pass `process.env` (or a test's object),
 * which keeps the resolution honest about being read at call time.
 */
export function feedBaseUrl(
	env: Record<string, string | undefined>,
	envVar: string,
	fallback: string
): string {
	const raw = env[envVar]?.trim();
	if (!raw) return fallback;
	if (!/^https?:\/\//i.test(raw)) throw new FeedBaseUrlError(envVar, raw);
	return raw.replace(/\/+$/, '');
}
