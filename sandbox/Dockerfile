# Command sandbox image.
#
# The backend runs agent/terminal commands with:
#   docker run --rm --init --user 1000:1000 --network <none|bridge>
#     --memory ... --cpus ... --pids-limit ...
#     --tmpfs /tmp -v <project>:/workspace:rw <this image> /bin/sh -c "<cmd>"
#
# So this image only needs a POSIX shell plus the toolchains a project may use.
# It deliberately contains no backend source, no credentials and no Docker
# socket.
#
#   docker build -f sandbox/Dockerfile -t my-ai-studio-sandbox:latest .
FROM debian:bookworm-slim

ARG INSTALL_ANDROID_TOOLCHAIN=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      coreutils \
      curl \
      git \
      nodejs \
      npm \
      procps \
      python3 \
      unzip \
      zip \
 && rm -rf /var/lib/apt/lists/*

# Optional JDK 17 for Gradle builds. Enabled with
# --build-arg INSTALL_ANDROID_TOOLCHAIN=1. The Android SDK itself is large and
# is mounted read-only at /opt/android-sdk by the operator when needed.
RUN if [ "$INSTALL_ANDROID_TOOLCHAIN" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends openjdk-17-jdk-headless \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# The numeric uid matches `--user 1000:1000`; /workspace is bind-mounted per run.
RUN groupadd --gid 1000 sandbox 2>/dev/null || true \
 && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash sandbox 2>/dev/null || true

USER 1000:1000
WORKDIR /workspace
ENV HOME=/home/sandbox
CMD ["/bin/sh"]
