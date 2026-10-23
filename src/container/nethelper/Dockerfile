# Network helper for kunj branch containers (kunj-nethelper:<version>-<hash of this directory>). Runs with
# --network container:<agent container> and NET_ADMIN/NET_RAW, and owns the firewall of that
# shared network namespace; the agent's container has NET_ADMIN and NET_RAW dropped, so it cannot
# change or bypass the rules.
FROM alpine:3.20

# socat: `kunj ct forward` tunnels into the shared network namespace through this container
RUN apk add --no-cache iptables ip6tables ipset bind-tools curl socat

COPY firewall.sh /firewall.sh
RUN chmod 0755 /firewall.sh

ENTRYPOINT ["/firewall.sh"]
