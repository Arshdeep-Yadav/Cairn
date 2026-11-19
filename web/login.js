'use strict';

/* Cairn login — no build step, no inline script (strict CSP). */

(function theme() {
  try {
    const saved = localStorage.getItem('cairn.theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.dataset.theme = saved;
    }
  } catch {
    // Storage can be unavailable in hardened browsers.
  }
})();

function ready(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

function bindReveal(button, input) {
  if (!button || !input) return;
  button.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.setAttribute('aria-pressed', showing ? 'false' : 'true');
    button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    input.focus();
  });
}

ready(() => {
  const loginView = document.getElementById('login-view');
  const mustChangeView = document.getElementById('must-change-view');

  const form = document.getElementById('login-form');
  const password = document.getElementById('password');
  const submit = document.getElementById('submit');
  const reveal = document.getElementById('reveal');
  const errorBox = document.getElementById('login-error');
  const capsHint = document.getElementById('caps-hint');
  const status = document.getElementById('server-status');
  const statusFoot = status?.closest('.form-foot');

  const mustChangeForm = document.getElementById('must-change-form');
  const currentPassword = document.getElementById('current-password');
  const newPassword = document.getElementById('new-password');
  const confirmPassword = document.getElementById('confirm-password');
  const mustChangeSubmit = document.getElementById('must-change-submit');
  const revealNew = document.getElementById('reveal-new');
  const mustChangeError = document.getElementById('must-change-error');

  function setStatus(text, state) {
    if (status) status.textContent = text;
    if (statusFoot) {
      statusFoot.classList.remove('is-online', 'is-offline');
      if (state) statusFoot.classList.add(`is-${state}`);
    }
  }

  function showError(box, input, message) {
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
    input?.setAttribute('aria-invalid', 'true');
    input?.focus();
  }

  function clearError(box, input) {
    if (!box) return;
    box.hidden = true;
    box.textContent = '';
    input?.removeAttribute('aria-invalid');
  }

  function setBusy(button, input, busy) {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (input) input.readOnly = busy;
  }

  function safeNext() {
    const target = new URLSearchParams(location.search).get('next');
    if (!target || !target.startsWith('/') || target.startsWith('//')) return '/';
    return target;
  }

  function goHome() {
    location.replace(safeNext());
  }

  function showMustChange(prefill) {
    if (loginView) loginView.hidden = true;
    if (mustChangeView) mustChangeView.hidden = false;
    if (prefill && currentPassword && !currentPassword.value) {
      currentPassword.value = prefill;
    }
    setStatus('First login — choose a permanent password', 'online');
    currentPassword?.focus();
  }

  // If the workspace is already unlocked, skip straight in.
  fetch('/api/auth/status', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error('offline'))))
    .then((data) => {
      if (data.authenticated) {
        goHome();
        return;
      }
      if (data.mustChangePassword) {
        showMustChange();
        return;
      }
      setStatus(`Workspace ${data.version || ''} ready · password required`.replace('  ', ' '), 'online');
    })
    .catch(() => {
      setStatus('Workspace unreachable — is `cairn start` still running?', 'offline');
    });

  bindReveal(reveal, password);
  bindReveal(revealNew, newPassword);

  const capsCheck = (event) => {
    if (typeof event.getModifierState !== 'function') return;
    if (capsHint) capsHint.hidden = !event.getModifierState('CapsLock');
  };
  password?.addEventListener('keydown', capsCheck);
  password?.addEventListener('keyup', capsCheck);

  password?.addEventListener('input', () => {
    if (errorBox && !errorBox.hidden) clearError(errorBox, password);
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(errorBox, password);
    const value = password.value;
    if (!value) {
      showError(errorBox, password, 'Enter the workspace password.');
      return;
    }
    setBusy(submit, password, true);
    setStatus('Checking password…');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ password: value }),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // Fall through to a status-based message.
      }
      if (response.ok) {
        password.value = '';
        setStatus('Unlocked. Opening the workspace…', 'online');
        goHome();
        return;
      }
      if (response.status === 403 && payload?.code === 'must_change') {
        // First login with the generated password: force a permanent one.
        showMustChange(value);
        return;
      }
      if (response.status === 429) {
        showError(errorBox, password, payload?.error || 'Too many failed attempts. Wait a few minutes and try again.');
        setStatus('Login temporarily locked', 'offline');
      } else if (response.status === 401) {
        showError(errorBox, password, 'Incorrect password. Check the value printed by `cairn start`.');
        setStatus('Workspace ready · password required', 'online');
      } else {
        showError(errorBox, password, payload?.error || `Could not unlock the workspace (${response.status}).`);
        setStatus('Workspace error', 'offline');
      }
    } catch {
      showError(errorBox, password, 'Could not reach the workspace. Is the server still running?');
      setStatus('Workspace unreachable', 'offline');
    } finally {
      setBusy(submit, password, false);
      password.focus();
      password.select();
    }
  });

  mustChangeForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(mustChangeError, newPassword);
    const current = currentPassword.value;
    const next = newPassword.value;
    const confirm = confirmPassword.value;
    if (!current) {
      showError(mustChangeError, currentPassword, 'Enter the generated password from `cairn start`.');
      return;
    }
    if (next.length < 12) {
      showError(mustChangeError, newPassword, 'The new password must be at least 12 characters.');
      return;
    }
    if (next !== confirm) {
      showError(mustChangeError, confirmPassword, 'The new passwords do not match.');
      return;
    }
    setBusy(mustChangeSubmit, newPassword, true);
    setStatus('Saving your password…');
    try {
      const response = await fetch('/api/auth/must-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ current, next }),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // Fall through to a status-based message.
      }
      if (response.ok) {
        setStatus('Password saved. Opening the workspace…', 'online');
        goHome();
        return;
      }
      if (response.status === 429) {
        showError(mustChangeError, currentPassword, payload?.error || 'Too many failed attempts. Wait a few minutes and try again.');
        setStatus('Login temporarily locked', 'offline');
      } else if (response.status === 401) {
        showError(mustChangeError, currentPassword, 'Incorrect generated password. Check the value printed by `cairn start`.');
        setStatus('First login — choose a permanent password', 'online');
      } else if (response.status === 400) {
        showError(mustChangeError, newPassword, payload?.error || 'That password was not accepted.');
        setStatus('First login — choose a permanent password', 'online');
      } else {
        showError(mustChangeError, newPassword, payload?.error || `Could not save the password (${response.status}).`);
        setStatus('Workspace error', 'offline');
      }
    } catch {
      showError(mustChangeError, newPassword, 'Could not reach the workspace. Is the server still running?');
      setStatus('Workspace unreachable', 'offline');
    } finally {
      setBusy(mustChangeSubmit, newPassword, false);
      newPassword.focus();
      newPassword.select();
    }
  });
});
