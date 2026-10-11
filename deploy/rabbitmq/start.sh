#!/bin/sh
# Writes the deployment-specific broker settings, then starts RabbitMQ.
#   BROKER_AUTH_URL         where rabbitmq_auth_backend_http reaches the platform,
#                           including the secret path segment (required)
#   MANAGEMENT_PATH_PREFIX  serve the management UI under this path (optional)
set -eu
: "${BROKER_AUTH_URL:?set BROKER_AUTH_URL, e.g. http://platform:8081/broker/<secret>}"

conf=/etc/rabbitmq/conf.d/95-soulcloud-runtime.conf
{
  for p in user vhost resource topic; do
    echo "auth_http.${p}_path = ${BROKER_AUTH_URL}/${p}"
  done
  if [ -n "${MANAGEMENT_PATH_PREFIX:-}" ]; then
    echo "management.path_prefix = ${MANAGEMENT_PATH_PREFIX}"
  fi
} > "$conf"

exec docker-entrypoint.sh rabbitmq-server
