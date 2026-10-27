# Default image for kunj branch containers (kunj-sandbox:<version>-<hash of this directory>). Modelled on
# github.com/anthropics/claude-code/.devcontainer without the firewall: the network
# helper container owns the rules, so this image has no sudo and no iptables.
FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

# Base tools, Node 22 LTS from NodeSource, gh from GitHub's apt repository and Claude Code
# (installed under /usr as root, so a volume on the home directory cannot hide it), one layer
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-lfs curl ca-certificates tmux socat iproute2 procps zsh openssh-client gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

COPY git-credential-kunj /usr/local/bin/git-credential-kunj

COPY zshrc /etc/zsh/zshrc

RUN chmod 0755 /usr/local/bin/git-credential-kunj \
 && chmod 0644 /etc/zsh/zshrc \
 && printf '\n# kunj: zsh would run its first-run wizard (no ~/.zshrc in the home volume) right after\n# this file and before /etc/zsh/zshrc, so it is turned off here\nzsh-newuser-install() { :; }\n' >> /etc/zsh/zshenv \
 && useradd -m -u 1000 -s /bin/zsh dev \
 && mkdir -p /workspace \
 && chown dev:dev /workspace

# npm installs globals into the home directory, so the agent can add tools without root
ENV NPM_CONFIG_PREFIX=/home/dev/.npm-global
ENV PATH=/home/dev/.npm-global/bin:$PATH
# bookworm-slim ships no locale; without a UTF-8 one Claude Code and tmux draw boxes as underscores
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color

USER dev

WORKDIR /workspace
