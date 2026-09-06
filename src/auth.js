import { Innertube, Log } from 'youtubei.js';

// Parser diagnostics can include account data. Surface only our own errors.
Log.setLevel(Log.Level.NONE);

export class AuthenticationRequiredError extends Error {
  constructor(message = 'Connect your browser cookies first.') {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

export function parseCookies(input) {
  if (typeof input !== 'string' || input.length > 60000) {
    throw new AuthenticationRequiredError('Paste a Cookie header or YouTube cookies.txt export.');
  }
  const text = input.trim();
  const pairs = new Map();
  if (text.includes('\t')) {
    for (let line of text.split(/\r?\n/u)) {
      if (line.startsWith('#HttpOnly_')) line = line.slice(10);
      else if (!line || line.startsWith('#')) continue;
      const columns = line.split('\t');
      if (columns.length !== 7) continue;
      const [domain, , , , expiry, name, value] = columns;
      if (!/(^|\.)youtube\.com$/iu.test(domain.replace(/^\./u, ''))) continue;
      if (Number(expiry) !== 0 && Number(expiry) < Date.now() / 1000) continue;
      pairs.set(name, value);
    }
  } else {
    if (/[\r\n]/u.test(text)) {
      throw new AuthenticationRequiredError(
        'Paste just the Cookie header value, not all request headers.',
      );
    }
    for (const part of text.replace(/^cookie:\s*/iu, '').split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0)
        pairs.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }
  for (const [name, value] of pairs) {
    if (!/^[\w-]+$/u.test(name) || /[\r\n;\x00-\x1f]/u.test(value)) {
      throw new AuthenticationRequiredError('The cookie input has an invalid name or value.');
    }
  }
  if (!pairs.get('SAPISID') && !pairs.get('__Secure-3PAPISID')) {
    throw new AuthenticationRequiredError(
      'No YouTube sign-in cookie found. Copy the Cookie request header while signed in.',
    );
  }
  // YouTube.js signs requests with SAPISID; some browser exports only include
  // the equivalent secure third-party cookie.
  if (!pairs.get('SAPISID')) pairs.set('SAPISID', pairs.get('__Secure-3PAPISID'));
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function createAuthenticatedFetch(fetchImpl = fetch) {
  return async (input, init) => {
    const response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(30000) });
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers ?? input?.headers);
    if (
      url.origin === 'https://www.youtube.com' &&
      url.pathname.startsWith('/youtubei/') &&
      headers.has('authorization')
    ) {
      // Account names can still be returned for a signed-out session. Check
      // YouTube's explicit auth status before the parser drops responseContext.
      const data = response.ok
        ? await response
            .clone()
            .json()
            .catch(() => null)
        : null;
      if (
        response.status === 401 ||
        data?.responseContext?.mainAppWebResponseContext?.loggedOut === true
      ) {
        throw new AuthenticationRequiredError(
          'YouTube reports this session is signed out or expired. Disconnect and reconnect with a fresh, complete Cookie request header from a signed-in YouTube tab.',
        );
      }
    }
    return response;
  };
}

async function createSession(credentials) {
  try {
    return await Innertube.create({
      cookie: credentials.cookie,
      account_index: credentials.accountIndex,
      on_behalf_of_user: credentials.channelId || undefined,
      retrieve_player: false,
      enable_session_cache: false,
      fetch: createAuthenticatedFetch(),
    });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) throw error;
    throw new AuthenticationRequiredError(
      'Could not open a YouTube session. Check connectivity or replace the cookies.',
    );
  }
}

export function validateCredentials(input, accountIndex = 0, channelId = '') {
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 20) {
    throw new AuthenticationRequiredError('Account index must be a number from 0 to 20.');
  }
  if (typeof channelId !== 'string' || (channelId && !/^[\w-]{1,128}$/u.test(channelId))) {
    throw new AuthenticationRequiredError('Invalid delegated channel ID.');
  }
  return { cookie: parseCookies(input), accountIndex, channelId };
}

// Never guess from the first account: the list can include other channels.
export function selectedAccountIdentity(accounts) {
  const selected = accounts.find((account) => account.is_selected && !account.is_disabled);
  const name = selected?.account_name?.toString().trim();
  return name ? { name: name.slice(0, 200) } : null;
}

export async function connectCookies(input, accountIndex = 0, channelId = '') {
  const credentials = validateCredentials(input, accountIndex, channelId);
  const session = await createSession(credentials);
  try {
    const accounts = await session.account.getInfo(true);
    if (!accounts.length) throw new Error('No accounts');
    return { connected: true, identity: selectedAccountIdentity(accounts) };
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) throw error;
    throw new AuthenticationRequiredError(
      'YouTube did not accept these cookies. Copy fresh cookies from a signed-in YouTube tab.',
    );
  }
}

export async function authenticatedSession(auth) {
  if (!auth?.cookies) throw new AuthenticationRequiredError();
  return createSession(
    validateCredentials(auth.cookies, auth.accountIndex ?? 0, auth.channelId ?? ''),
  );
}
