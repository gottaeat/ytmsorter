import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCookies,
  createAuthenticatedFetch,
  AuthenticationRequiredError,
  selectedAccountIdentity,
} from '../src/auth.js';

test('session identity uses only the selected enabled channel and exposes only its display name', () => {
  assert.deepEqual(
    selectedAccountIdentity([
      { account_name: 'Wrong channel', is_selected: false },
      {
        account_name: { toString: () => '  Operator  ' },
        is_selected: true,
        email: 'private@example.test',
      },
    ]),
    { name: 'Operator' },
  );
  assert.equal(selectedAccountIdentity([{ account_name: 'Not selected' }]), null);
  assert.equal(
    selectedAccountIdentity([{ account_name: 'Disabled', is_selected: true, is_disabled: true }]),
    null,
  );
  assert.equal(selectedAccountIdentity([{ is_selected: true }]), null);
});

test('authenticated requests detect signed-out responses and 401 without exposing credentials', async () => {
  for (const response of [
    Response.json({ responseContext: { mainAppWebResponseContext: { loggedOut: true } } }),
    new Response('secret-cookie', { status: 401 }),
  ]) {
    const checkedFetch = createAuthenticatedFetch(async () => response);
    await assert.rejects(
      checkedFetch(new Request('https://www.youtube.com/youtubei/v1/browse'), {
        headers: { Authorization: 'secret-cookie' },
      }),
      (error) =>
        error instanceof AuthenticationRequiredError &&
        /signed out or expired/u.test(error.message) &&
        !error.message.includes('secret-cookie'),
    );
  }
});

test('auth checking preserves response bodies and permits anonymous bootstrap requests', async () => {
  for (const loggedOut of [true, false]) {
    const data = { responseContext: { mainAppWebResponseContext: { loggedOut } } };
    const checkedFetch = createAuthenticatedFetch(async () => Response.json(data));
    const response = await checkedFetch('https://www.youtube.com/youtubei/v1/browse', {
      headers: loggedOut ? {} : { Authorization: 'fake' },
    });
    assert.deepEqual(await response.json(), data);
  }
});

test('accepts a Cookie header without disclosing it in errors', () => {
  assert.equal(parseCookies('Cookie: SAPISID=fake; SID=other'), 'SAPISID=fake; SID=other');
  assert.throws(
    () => parseCookies('SAPISID=secret\nHost: bad'),
    (error) => !error.message.includes('secret'),
  );
  assert.throws(() => parseCookies('SID=not-signed-in'), /No YouTube/u);
  assert.equal(parseCookies('__Secure-3PAPISID=fake'), '__Secure-3PAPISID=fake; SAPISID=fake');
});

test('Netscape import includes only unexpired YouTube cookies, including HttpOnly', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tfake',
    '.google.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-other-domain',
    '.youtube.com\tTRUE\t/\tTRUE\t1\tOLD\texpired',
  ].join('\n');
  assert.equal(parseCookies(text), 'SAPISID=fake');
});
