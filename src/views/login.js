// Sign in: email, then a 6-digit code. The link in the email works too.
// No workspace name shows here. A stranger learns nothing from the URL.
import { esc } from '../lib/format.js';

export function renderLogin(el, { step = 'email', email = '', err = '', busy = false } = {}) {
  if (step === 'code') {
    el.innerHTML = `<div class="gate"><form class="card" data-form="code" novalidate>
      <h1>Check your email</h1>
      <p>If ${esc(email)} is on the roster, a 6-digit code is on its way. Type it here or tap the link in the email.</p>
      <label for="code">Code</label>
      <input id="code" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" required autofocus>
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <button class="btn" ${busy ? 'disabled' : ''}>${busy ? 'Checking...' : 'Sign in'}</button>
      <div class="foot"><button type="button" class="lnk" data-login-back>Use a different email</button><button type="button" class="lnk" data-login-resend>Send a new code</button></div>
    </form></div>`;
    return;
  }
  el.innerHTML = `<div class="gate"><form class="card" data-form="email" novalidate>
    <h1>Summit</h1>
    <p>Sign in with your work email. We'll send you a code. No password.</p>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" value="${esc(email)}" required autofocus>
    ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
    <button class="btn" ${busy ? 'disabled' : ''}>${busy ? 'Sending...' : 'Send my code'}</button>
  </form></div>`;
}

export function renderGate(el, { title, body = '', list = [], signOut = true }) {
  el.innerHTML = `<div class="gate"><div class="card">
    <h1>${esc(title)}</h1>
    ${body ? `<p>${esc(body)}</p>` : ''}
    ${list.length ? `<ul>${list.map((x) => `<li><a href="/${esc(x.slug)}">${esc(x.name)}</a></li>`).join('')}</ul>` : ''}
    ${signOut ? '<button class="btn sec" data-signout>Sign out</button>' : ''}
  </div></div>`;
}
