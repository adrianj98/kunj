# Network helper for kunj branch containers (kunj-nethelper:<version>-<hash of this directory>). Runs with
# --network container:<agent container> and NET_ADMIN/NET_RAW, and owns the firewall of that
# shared network namespace, so the agent's container needs no capabilities or sudo.
FROM alpine:3.20

RUN apk add --no-cache iptables ip6tables ipset bind-tools curl

COPY firewall.sh /firewall.sh
RUN chmod 0755 /firewall.sh

ENTRYPOINT ["/firewall.sh"]
