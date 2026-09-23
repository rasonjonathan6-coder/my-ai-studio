# Backend image. Build context must be the repository root because this is an
# npm workspace: the single lockfile lives at the root and backend/ has no
# lockfile of its own.
#
#   docker build -f backend/Dockerfile -t my-ai-studio-backend .
FROM node:22-bookworm-slim AS deps

WORKDIR /repo
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# Install only the backend workspace; the frontend is built and served
# separately. Dev deps are included because the build needs TypeScript.
RUN npm ci --workspace backend --include-workspace-root

FROM node:22-bookworm-slim AS runtime

ARG INSTALL_ANDROID_TOOLCHAIN=0
# Docker CLI client only, for the optional command sandbox (SANDBOX_ENABLED).
# It talks to a socket mounted by the operator; no daemon runs in this image.
ARG INSTALL_DOCKER_CLI=0
ARG DOCKER_CLI_VERSION=27.3.1

# git: agent git tools. procps: process listing used by system status.
# zip/unzip: used by the project export and artifact inspection paths.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git procps ca-certificates unzip zip \
 && rm -rf /var/lib/apt/lists/*

# Static Docker CLI client. Needed only when SANDBOX_ENABLED=true, where the
# backend shells out to `docker run` against a socket mounted by the operator.
# The client alone is harmless: no daemon runs in this image.
COPY --from=docker:27.3.1-cli /usr/local/bin/docker /usr/local/bin/docker

# Optional JDK 17 for Gradle builds. The Android SDK stays out of the default
# image because of size; mount it or use a dedicated builder for in-container
# APK builds.
RUN if [ "$INSTALL_ANDROID_TOOLCHAIN" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless && \
      rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/src ./backend/src
COPY backend/tests ./backend/tests
COPY backend/assets ./backend/assets

# Compile TypeScript. `tsc` does not copy .sql files, so migrations are placed
# next to the compiled migrate.js, which resolves them relative to itself.
RUN cd backend \
 && ../node_modules/.bin/tsc -p tsconfig.json \
 && mkdir -p dist/db/migrations \
 && cp src/db/migrations/*.sql dist/db/migrations/

RUN mkdir -p /data/workspaces /data/storage \
 && chown -R node:node /repo /data

# Run as the unprivileged node user: a build tool must not own the container.
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    WORKSPACE_PATH=/data/workspaces \
    STORAGE_PATH=/data/storage \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/gradle/gradle-8.9/bin:/opt/gradle/bin:/usr/lib/jvm/java-17-openjdk-amd64/bin:/usr/lib/jvm/java-21-openjdk-amd64/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/build-tools/34.0.0

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /repo/backend
CMD ["node", "dist/server.js"]
