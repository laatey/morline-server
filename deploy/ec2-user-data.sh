#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
REGION="__REGION__"
BUCKET="__S3_BUCKET__"
SECRET_ID="__SECRET_ID__"

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl docker.io docker-compose-v2 tar unzip
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update
rm -rf /tmp/aws /tmp/awscliv2.zip
systemctl enable --now docker

install -d -m 0755 /opt/morline /opt/morline/data /etc/morline
aws s3 cp "s3://${BUCKET}/releases/morline-server-source.tar.gz" /tmp/morline-source.tar.gz --region "$REGION"
aws s3 cp "s3://${BUCKET}/releases/morline-server-data.tar.gz" /tmp/morline-data.tar.gz --region "$REGION"

tar -xzf /tmp/morline-source.tar.gz -C /opt/morline
tar -xzf /tmp/morline-data.tar.gz -C /opt/morline/morline-server
cp -a /opt/morline/morline-server/data/. /opt/morline/data/
rm -rf /opt/morline/morline-server/data /tmp/morline-source.tar.gz /tmp/morline-data.tar.gz
chown -R 1000:1000 /opt/morline/data

aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" \
  --region "$REGION" \
  --query SecretString \
  --output text > /etc/morline/morline.env
cat >> /etc/morline/morline.env <<'EOF'
NODE_ENV=production
DATA_DIR=/data
ENABLE_CLOUDFLARE_TUNNEL=false
EOF
chmod 0600 /etc/morline/morline.env

cd /opt/morline/morline-server
DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)" docker compose -f docker-compose.production.yml up --build -d
