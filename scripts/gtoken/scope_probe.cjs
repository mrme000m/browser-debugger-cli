const tok = require(process.argv[2] || '/tmp/cc_alive.json').refresh_token;
const SCOPES = [
  ['accounts/OAuthLogin', 'https://www.google.com/accounts/OAuthLogin'],
  ['chromesync', 'https://www.googleapis.com/auth/chromesync'],
  ['userinfo.email', 'https://www.googleapis.com/auth/userinfo.email'],
  ['userinfo.profile', 'https://www.googleapis.com/auth/userinfo.profile'],
  ['gmail', 'https://mail.google.com/'],
  ['gmail.readonly', 'https://www.googleapis.com/auth/gmail.readonly'],
  ['drive', 'https://www.googleapis.com/auth/drive'],
  ['drive.file', 'https://www.googleapis.com/auth/drive.file'],
  ['drive.appdata', 'https://www.googleapis.com/auth/drive.appdata'],
  ['calendar', 'https://www.googleapis.com/auth/calendar'],
  ['contacts', 'https://www.googleapis.com/auth/contacts'],
  ['tasks', 'https://www.googleapis.com/auth/tasks'],
  ['youtube', 'https://www.googleapis.com/auth/youtube'],
  ['photos', 'https://www.googleapis.com/auth/photoslibrary'],
  ['keep', 'https://www.googleapis.com/auth/keep'],
  ['docs', 'https://www.googleapis.com/auth/documents'],
  ['drive.metadata', 'https://www.googleapis.com/auth/drive.metadata.readonly'],
  ['books', 'https://www.googleapis.com/auth/books'],
  ['fitness', 'https://www.googleapis.com/auth/fitness.activity.read'],
  ['forms', 'https://www.googleapis.com/auth/forms'],
  ['classroom', 'https://www.googleapis.com/auth/classroom.courses.readonly'],
  ['chat', 'https://www.googleapis.com/auth/chat.readonly'],
  ['hangouts', 'https://www.google.com/talk/'],
  ['android.phone', 'https://www.googleapis.com/auth/android_phone_service'],
  ['webhistory', 'https://www.googleapis.com/auth/webhistory'],
  ['accountinfo', 'https://www.googleapis.com/auth/accountinfo'],
  ['profile-plus', 'https://www.googleapis.com/auth/plus.login'],
  ['wallet', 'https://www.googleapis.com/auth/wallet_object.issuer'],
];
(async () => {
  const ok = [], blocked = [], err = [];
  for (const [name, scope] of SCOPES) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'},
        body: new URLSearchParams({ grant_type:'refresh_token', client_id:'77185425430.apps.googleusercontent.com', client_secret:'OTJgUOQcT7lO7GsGZq2G4IlT', refresh_token: tok, scope }) });
      const j = await r.json();
      if (j.access_token) ok.push(name);
      else if (j.error === 'restricted_client' || j.error === 'invalid_scope') blocked.push(name + ':' + j.error);
      else err.push(name + ':' + j.error + (j.error_description ? ' | ' + j.error_description.slice(0,60) : ''));
    } catch (e) { err.push(name + ':net'); }
  }
  console.log('✅ MINTABLE (' + ok.length + '):', ok.join(', '));
  console.log('⛔ BLOCKED (' + blocked.length + '):', blocked.join(', '));
  console.log('⚠️ OTHER (' + err.length + '):', err.join(' ;; '));
})();
