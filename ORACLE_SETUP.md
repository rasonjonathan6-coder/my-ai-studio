# Oracle Cloud Always Free setup

Oracle Cloud's Always Free tier is enough to run the backend: one VM with up to
4 ARM cores and 24 GB RAM (Ampere A1), or the x86 micro instance (1 OCPU, 1 GB).
The ARM shape is the better choice; a Gradle build in 1 GB of RAM will struggle.

> **Status: not tested.** Nothing in this repository has been deployed to Oracle
> Cloud, and this machine has no Oracle access. The steps below are the standard
> procedure and are written from the documents linked at the end - treat them as
> a script to follow, not as a report of something that was executed.

## 1. Create the VM

1. Sign up at <https://cloud.oracle.com> and pick a home region.
2. **Compute -> Instances -> Create instance.**
3. Image: **Ubuntu 22.04** (or 24.04). Shape: **VM.Standard.A1.Flex**, 2-4 OCPUs,
   12-24 GB RAM, within the Always Free allowance.
4. Download the SSH key pair when prompted. It is shown once.
5. Create, then note the public IP.

SSH in:

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<public-ip>
```

## 2. Base packages

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git ufw

# Docker Engine from the official repository
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
sudo usermod -aG docker ubuntu
newgrp docker
docker run hello-world
```

## 3. Clone and configure

```bash
git clone https://github.com/<owner>/<repo>.git my-ai-studio
cd my-ai-studio

cp .env.production.example .env
openssl rand -hex 32          # paste into JWT_SECRET
nano .env
```

Set at minimum `DATABASE_URL` (Supabase, or the Postgres container from
`docker-compose.yml`) and `JWT_SECRET`. If you build the sandbox image and want
agent commands containerised, set `SANDBOX_ENABLED=true`.

```bash
sudo mkdir -p /data/workspaces /data/storage
sudo chown -R 1000:1000 /data/workspaces /data/storage
```

## 4. Build the images and start

```bash
# Sandbox image used by agent commands when SANDBOX_ENABLED=true
docker build -t my-ai-studio-sandbox:latest sandbox/

docker compose up -d --build
docker compose ps
docker compose logs -f backend
```

Verify:

```bash
curl -s http://127.0.0.1:8080/api/health
bash scripts/smoke.sh
```

## 5. Networking - both layers

This is the step people lose an afternoon to. Oracle has **two** independent
firewalls and both must allow traffic.

**VCN security list.** In the console: **Networking -> Virtual Cloud Networks ->
your VCN -> Security Lists -> Default Security List -> Add Ingress Rules.**

| Source CIDR | Protocol | Destination port |
| --- | --- | --- |
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |

**Instance firewall.** The Ubuntu images ship with iptables rules that reject
everything except SSH, and Oracle's `iptables-persistent` may restore them on
boot. Either use `ufw`:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

or leave the default rules alone and just don't open 8080 to the world - the
reverse proxy reaches it over loopback.

## 6. HTTPS

Point a DNS `A` record at the public IP, then put Caddy in front. A minimal
`/etc/caddy/Caddyfile`:

```
your-domain.example {
    encode gzip
    reverse_proxy /api/* 127.0.0.1:8080
    reverse_proxy /ws/*  127.0.0.1:8080
}
```

Caddy obtains and renews the certificate automatically once 80 and 443 are open.

## 7. Start on boot

The Compose plugin installs a systemd unit. Either rely on `restart: unless-stopped`
in `docker-compose.yml` plus:

```bash
sudo systemctl enable docker
```

or install the explicit unit from `DEPLOYMENT.md` section "Option B".

## 8. Logs and maintenance

```bash
docker compose logs -f --tail=200 backend
docker stats                    # watch RAM against the VM's allowance
docker system df                # image and build-cache growth
docker compose pull && docker compose up -d --build
```

Gradle build caches are the usual cause of a full disk on the small shapes.
Prune them periodically:

```bash
docker builder prune -f
docker image prune -f
```

## Free-tier realities to plan around

- **ARM vs x86 images.** The A1 shape is ARM64. Any image you build must be
  `arm64`-compatible; the shipped `Dockerfile`s are multi-arch and fine, but a
  prebuilt `amd64` toolchain image is not.
- **Idle reclaim.** Oracle reclaims Always Free compute that stays idle. An
  instance with no public IP for seven days, low CPU and low network over seven
  days is a candidate. Keeping the reverse proxy and a periodic health check on
  the instance is usually enough to stay outside the definition.
- **Outbound limits.** Heavy Gradle dependency downloads are part of the free
  egress allowance but not free forever; watch the tenancy's data transfer.
- **Boot volume.** 47 GB is the default free boot volume. Android SDK plus
  Gradle caches can approach that, so keep working projects small or attach a
  block volume.

## References

- Oracle Always Free resources: <https://www.oracle.com/cloud/free/>
- OCI ingress rules: <https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm>
- Docker Engine on Ubuntu: <https://docs.docker.com/engine/install/ubuntu/>
