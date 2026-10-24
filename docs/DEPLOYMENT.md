# Deployment (Linux VPS), backups and recovery

## 1. Server preparation (Ubuntu 24.04)

```bash
adduser --system --group nie && adduser --system --group nie-backup
apt install nginx certbot python3-certbot-nginx age clamav-daemon redis-server
# MongoDB 7: install from repo.mongodb.org, then in /etc/mongod.conf:
#   replication: { replSetName: rs0 }    security: { authorization: enabled }
#   net: { bindIp: 127.0.0.1 }
mongosh --eval 'rs.initiate()'
# create an application user limited to the northern_iebc database (readWrite) and a backup user (backup role)
```
Use three replica-set members for elections, so the database can fail over.

## 2. Application

```bash
git clone <repo> /srv/northern-iebc && cd /srv/northern-iebc
npm ci && npm run build
cp server/.env.example server/.env   # set NODE_ENV=production, https URLs, TRUST_PROXY=1, secrets, CLAMAV_HOST=127.0.0.1, REDIS_URL
chmod 600 server/.env && chown nie: server/.env
npm run db:init -w server && npm run db:seed-reference -w server
ADMIN_EMAIL=… ADMIN_NAME=… ADMIN_PASSWORD=… npm run user:create-admin -w server
npm i -g pm2@5 && pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup
```
Production refuses to start with `ALLOW_UNSCANNED_UPLOADS=true` or non-HTTPS URLs. Keep `UPLOAD_DIR` outside the web root.

## 3. Nginx and HTTPS

Copy `deploy/nginx/northern-iebc.conf` to `/etc/nginx/sites-available/` and `nie-proxy.conf` to `/etc/nginx/snippets/`, then set the domain and run `certbot --nginx -d your.domain`. The config serves `web/dist`, proxies `/api` and `/socket.io`, rate-limits auth, and sets HSTS and CSP.

## 4. Payment providers

- **M-Pesa**: create a Daraja app. Set the consumer key/secret, shortcode, passkey and a random `MPESA_CALLBACK_TOKEN` (24+ characters); the callback URL is `https://your.domain/api/payments/mpesa/callback/<token>`. Test in sandbox, then in production with a small live payment, then set `MPESA_VERIFIED_OPERATIONAL=true`. Configure `MPESA_INITIATOR_NAME` and `MPESA_SECURITY_CREDENTIAL` to enable reversals (refunds).
- **Paystack**: set the secret key and add the webhook `https://your.domain/api/payments/paystack/webhook`.
- **PayPal**: set the client ID/secret and webhook ID (webhook URL `/api/payments/paypal/webhook`, events `PAYMENT.CAPTURE.*`).
Never put payment secrets in the web build. Only `server/.env` holds them, and the logger redacts them.

## 5. Monitoring

- `GET /healthz` (liveness) and `/readyz` (Mongo, Redis, outbox backlog) for an uptime checker.
- PM2 logs are structured JSON (pino). Ship them to your log store, and alert on `level >= 50`, on a growing `outboxBacklog`, and on failed backups (`HEALTHCHECK_URL`).
- ClamAV: `systemctl status clamav-daemon`. Uploads stay unservable while the scanner is down.

## 6. Backups

`deploy/scripts/backup.sh` dumps MongoDB (optionally point-in-time with `BACKUP_OPLOG=1` and an instance URI) and the uploads, encrypts both with **age**, writes checksums, copies off-site with `rclone`, and applies retention. Keep the age private key **off** the server (for example in a password manager and on paper in a safe).

```bash
install -m 600 /dev/null /etc/northern-iebc/backup.env   # MONGODB_URI, BACKUP_DIR, AGE_RECIPIENT, UPLOAD_DIR, RCLONE_REMOTE, HEALTHCHECK_URL
cp deploy/systemd/nie-backup.* deploy/systemd/nie-restore-test.* /etc/systemd/system/
systemctl enable --now nie-backup.timer nie-restore-test.timer
```

## 7. Restoration (tested weekly)

`deploy/scripts/restore-test.sh` restores the newest backup into a scratch database, prints collection counts, re-verifies the audit hash chain on the restored copy, and drops it. A successful backup job is not proof that a restore works, so run this test.

Full restore:
```bash
pm2 stop all
deploy/scripts/restore.sh /backups/<stamp> /secure/age-key.txt "mongodb://…/northern_iebc?replicaSet=rs0" --drop --uploads /srv/northern-iebc/server/uploads
npm run audit:verify -w server && pm2 start all
```

## 8. Incident procedures

- **Compromised credentials**: suspend the account (this ends its sessions immediately). For admins, also reset MFA (super admin). Rotate `JWT_ACCESS_SECRET` to invalidate all access tokens (users then refresh or sign in again). Review the audit log for the account.
- **Leaked payment secret**: rotate it at the provider and in `.env`, then `pm2 reload all`.
- **Suspected data tampering**: run `npm run audit:verify -w server`. Compare with the most recent restore-tested backup. Corrections are published as new revisions, never by editing history.
- **Corrupted records**: restore into a scratch database, extract the affected documents, and re-apply them through the normal correction workflow.

## Upgrades

Dependencies are pinned to exact versions. To upgrade: create a branch, update the versions, run `npm ci && npm run typecheck && npm test`, the e2e test and the load test against staging, then deploy with `pm2 reload` (zero downtime in cluster mode) and run `npm run db:init -w server` to sync any new indexes.
