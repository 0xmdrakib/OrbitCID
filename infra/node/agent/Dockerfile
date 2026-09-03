FROM rclone/rclone:1.75.0@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548 AS rclone
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
RUN apk add --no-cache bash ca-certificates curl jq coreutils
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY infra/kubo/bridge.mjs /app/infra/kubo/bridge.mjs
COPY backend/grant-auth.mjs /app/backend/grant-auth.mjs
COPY backend/r2-backup.mjs /app/backend/r2-backup.mjs
COPY backend/r2-restore.mjs /app/backend/r2-restore.mjs
COPY infra/node/backup/backup.sh /usr/local/bin/orbitcid-backup
COPY infra/node/backup/restore.sh /usr/local/bin/orbitcid-restore
RUN chmod 0555 /usr/local/bin/orbitcid-backup /usr/local/bin/orbitcid-restore
CMD ["node", "/app/infra/kubo/bridge.mjs"]
