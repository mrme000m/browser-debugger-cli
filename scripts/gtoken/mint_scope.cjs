const token = require(process.argv[2] || '/tmp/alive_google_token.json').refresh_token;
const scope = process.env.SCOPE || '';
fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'},
  body: new URLSearchParams({ grant_type:'refresh_token', client_id:'77185425430.apps.googleusercontent.com', client_secret:'OTJgUOQcT7lO7GsGZq2G4IlT', refresh_token: token, ...(scope?{scope}:{}) }) })
  .then(r => r.json()).then(j => { if (j.access_token) console.log('✅ minted | scope:', j.scope); else if (j.error) console.log('❌', j.error, '|', scope || '(default)'); else console.log('??', JSON.stringify(j).slice(0,120)); })
  .catch(e => console.log('network error', e.message));
