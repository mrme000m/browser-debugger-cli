# CLI Mail Archive — Guide (r00)

Programmatic import + management of all scraped mail accounts on `r00`
(192.46.214.24). Everything is config-driven and headless. Mail is pulled to
plain **Maildir** on disk under `~/emails/archive/`, indexed by **notmuch**
for search/tags, and backed up with **rclone** → OneDrive.

## Architecture
```
accounts.tsv (186 creds)
   ├─ 167 IMAP ─ mbsync ──────────┐
   └─ 19  POP3 ─ mpop  ───────────┤──> ~/emails/archive/<host>/<user>/Maildir/
                                   │        (plain files, rclone-ready)
                              notmuch  (index + tags + search)
                                   │
                              neomutt / notmuch CLI  (read/manage)
                                   │
        rclone copy ~/emails  onedrive:mail-archive/   (backup)
```

## 0. What's installed on r00
```
mbsync/isync 1.4.4   IMAP -> Maildir
mpop   1.4.18        POP3 -> Maildir
notmuch 0.38.3       index + search + tags
neomutt 20231103     read/reply over notmuch
rclone v1.75.0       copy to OneDrive
```

---

## 1. Sync everything (the one command)

```bash
ssh r00 'sh ~/emails/run_sync.sh'
```
What it does (in order):
1. `mbsync -c ~/emails/mbsyncrc -a` — all 167 IMAP/IMAPS accounts
2. `mpop --all-accounts -C ~/.mpoprc` — all 19 POP3 accounts
3. `notmuch new` — re-index any newly downloaded mail

Long-running / in background:
```bash
ssh r00 'cd ~/emails && nohup sh run_sync.sh > sync.log 2>&1 & echo $!'
```
Watch progress:
```bash
ssh r00 'tail -f ~/emails/sync.log'
```
Unreachable sellers are skipped and mbsync continues past them.

---

## 2. Manage the mailbox index (notmuch)

```bash
ssh r00 'notmuch new'                 # re-index after any sync
ssh r00 'notmuch search "from:rtbf"' # search
ssh r00 'notmuch search "tag:inbox and date:2026-08-01.."'
```

Tags live the maildir flags:
```bash
ssh r00 'notmuch tag +important -- "from:boss"'
ssh r00 'notmuch tag +archive -inbox -- "tag:new"'
```

Read / export threads:
```bash
ssh r00 'notmuch show --format=mbox id:ID > /tmp/thread.mbox'
ssh r00 'notmuch dump > /tmp/archive.dump'        # backup the index
ssh r00 'notmuch search --output=files "\"*\" | wc -l'   # total messages
```

### neomutt (terminal client)
```bash
ssh r00 -t 'neomutt -F ~/.neomuttrc'
```
Already wired to virtual mailboxes: `all`, `inbox`, `sent` (see `~/.neomuttrc`).
Neomutt opens the aggregate from the notmuch index — you read everything in
one mailbox tree, no per-account switching.

---

## 3. POP3 specifics (19 accounts)
Config: `~/.mpoprc` (one `account popN` block per box, implicit-TLS on 995).
Test a single box: `mpop -C ~/.mpoprc pop2` (pop.free.fr, verified OK).
Note: unlike IMAP, POP3 deletes mail off the server. mpop keeps a copy
because it delivers to Maildir before deleting. Add `keep on` per account if
you want to leave mail on the server:
```bash
# in ~/.mpoprc, per account:
keep on
```

---

## 4. rclone → OneDrive

One-time OAuth setup (needs a browser window; run THIS on your laptop, or
forward a port):

```bash
# on r00:
rclone config          # answer: n for new remote -> name "onedrive"
                      #   -> 1 Microsoft OneDrive  : OneDrive
```
`rclone config` prints a URL — open it in your browser, authorize, paste the
code back. When the `onedrive` remote exists:

```bash
# dry-run first
ssh r00 'rclone copy ~/emails onedrive:mail-archive --dry-run'
# real push
ssh r00 'nohup rclone copy ~/emails onedrive:mail-archive > ~/emails/rclone.log 2>&1 &'
# check
ssh r00 'rclone lsd onedrive:'
```
(Backs up both the Maildir archive and the SnappyMail state under
`~/emails/`.)

**OneDrive + sync details** (thanks to the earlier setup): rclone packs local
dirs as a flat list; no pre-sync delete. Files are deduplicated by path.

---

## 5. Recurring sync (recommended)

Add a systemd timer so new mail is continuously pulled + indexed:

```bash
ssh r00 'cat > ~/emails/sync.service <<EOF
[Unit]
Description=Mail archive sync
[Service]
ExecStart=/home/m/emails/run_sync.sh
EOF
sudo mv ~/emails/sync.service /etc/systemd/system/mailsync.service
cat > /tmp/mailsync.timer <<EOF
[Unit]
Description=Run mail sync hourly
[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
EOF
sudo mv /tmp/mailsync.timer /etc/systemd/system/mailsync.timer
sudo systemctl daemon-reload
sudo systemctl enable --now mailsync.timer
systemctl list-timers mailsync'
```

Manual run anytime: `ssh r00 'sh ~/emails/run_sync.sh'`.

---

## 6. Troubleshooting

- **"cannot open store"** — base Maildir needs to exist: 
  `mkdir -p ~/emails/archive/<host>/<user>/Maildir/{cur,new,tmp}` (the setup
  script pre-created these).
- **host unreachable / times out** — many scraped providers block foreign
  IPs or are dead. Confirm: `ssh r00 'nc -z -w5 HOST 993` `. The sync skips
  these; they aren't healthy creds.
- **mpop hangs** — TLS (implicit on 995) is set correctly via
  `tls on` + `tls_starttls off`. If a specific acct hangs, run:
  `timeout 20 mpop -C ~/.mpoprc popN` and test that host's 995.
- **notmuch your Maildirs grow** — set `exclude_tags` and re-run `notmuch new`.
- **Incremental sync with mbsync** — it remembers per-folder UIDVALIDITY
  (`.uidvalidity`) so re-running is cheap and non-destructive.