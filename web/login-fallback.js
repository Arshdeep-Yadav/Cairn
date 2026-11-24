/* Safety net for a stale or failed login.js: never leave an empty card.
   Shipped as a separate file so it runs under the page's script-src 'self'. */
setTimeout(() => {
  const loading = document.getElementById('auth-loading');
  if (loading) loading.hidden = true;
  const login = document.getElementById('login-view');
  const must = document.getElementById('must-change-view');
  if (login && must && login.hidden && must.hidden) login.hidden = false;
}, 2500);
