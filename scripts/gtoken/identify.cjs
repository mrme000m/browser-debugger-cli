const token = require(process.argv[2] || '/tmp/alive_google_token.json').refresh_token;
(async () => {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'},
    body: new URLSearchParams({ grant_type:'refresh_token', client_id:'77185425430.apps.googleusercontent.com', client_secret:'OTJgUOQcT7lO7GsGZq2G4IlT', refresh_token: token, scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile' }) });
  const j = await res.json();
  if (!j.access_token) { console.log('mint failed:', JSON.stringify(j)); return; }
  console.log('minted scope:', j.scope);
  const u = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + j.access_token } });
  const uj = await u.json();
  if (uj.email) console.log('👤 email:', uj.email, '| name:', uj.name, '| verified:', uj.email_verified, '| picture:', uj.picture ? '(yes)' : 'none');
  else console.log('userinfo response:', JSON.stringify(uj).slice(0, 300));
})();
