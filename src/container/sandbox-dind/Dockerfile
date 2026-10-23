# kunj-sandbox with Docker inside (container.dockerInDocker), tagged kunj-sandbox-dind:<version>-<hash of
# this directory and the base tag>. kunj builds it FROM the sandbox it has just built or found.
# dockerd is not started here: the container runs `sleep` until the network helper has the firewall
# up, then kunj runs kunj-dind-start as root.
# kunj always passes the tag; the default only keeps the build linter quiet
ARG BASE_IMAGE=kunj-sandbox
FROM ${BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive

USER root

# Docker Engine (dockerd, containerd, runc), the CLI and the compose plugin from Docker's apt
# repository; iptables for dockerd's own networking
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-compose-plugin iptables \
 && rm -rf /var/lib/apt/lists/*

COPY kunj-dind-start /usr/local/bin/kunj-dind-start

# The sandbox user reaches the socket through the docker group (dockerd's default socket group)
RUN chmod 0755 /usr/local/bin/kunj-dind-start \
 && usermod -aG docker dev

USER dev
