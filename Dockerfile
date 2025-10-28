# Dockerfile
FROM ubuntu:22.04

# Basic deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        bash \
        coreutils \
        ca-certificates \
        curl \
        python3 \
        python3-pip \
        g++ \
        openjdk-17-jdk-headless \
        nodejs \
        npm && \
    rm -rf /var/lib/apt/lists/*

# Some distros ship node as nodejs; ensure "node" exists
RUN if [ ! -f /usr/bin/node ]; then ln -s /usr/bin/nodejs /usr/bin/node || true; fi

WORKDIR /work
CMD ["/bin/bash"]
