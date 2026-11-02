ARG PROXY_BASE_IMAGE=alpine:3.20
FROM ${PROXY_BASE_IMAGE}
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter.setup filter.test /etc/tinyproxy/
COPY entrypoint.sh /entrypoint.sh
# The filter in force is chosen at start (PHASE=setup|test) and copied to /tmp,
# so switching phase = restarting the container; the image stays read-only.
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
