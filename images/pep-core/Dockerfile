#
# Pepecoin Core — built from the OFFICIAL release binaries published by the
# Pepecoin Core developers, verified against the SHA256 sums that are GPG-signed
# in SHA256SUMS.asc of the release.
#
# Nothing is pulled from third-party images.

ARG DEBIAN_VERSION=bookworm-slim
ARG PEPECOIN_VERSION=1.1.0

# ---------------------------------------------------------------------------
# Stage 1: download + verify + extract
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION} AS builder

# pipefail matters here: the checksum is verified through a pipe.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG PEPECOIN_VERSION
ARG TARGETARCH

# SHA256 sums taken verbatim from
# https://github.com/pepecoinppc/pepecoin/releases/download/v1.1.0/SHA256SUMS.asc
# (PGP-signed by the Pepecoin Core maintainers)
ARG SHA256_AMD64=9d7ef948e5726c9941cbc5307b4a0b725edc715bc10ed5515154485faecd710b
ARG SHA256_ARM64=c0abd1451e978a171ca5a7d37a57ecb79cc70c6755acf473018acbcd8d31083c

# Debian package versions are deliberately unpinned: the archive rotates them
# out, and a pinned version turns into an unbuildable image within months. What
# actually matters for reproducibility — the Pepecoin binaries — is pinned by
# SHA256 below.
# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    # TARGETARCH is provided by BuildKit; fall back to uname for the classic builder.
    ARCH="${TARGETARCH:-}"; \
    if [ -z "${ARCH}" ]; then \
      case "$(uname -m)" in \
        x86_64) ARCH=amd64 ;; \
        aarch64|arm64) ARCH=arm64 ;; \
        *) ARCH="$(uname -m)" ;; \
      esac; \
    fi; \
    case "${ARCH}" in \
      amd64) PEP_ARCH="x86_64-linux-gnu";  PEP_SHA="${SHA256_AMD64}" ;; \
      arm64) PEP_ARCH="aarch64-linux-gnu"; PEP_SHA="${SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac; \
    TARBALL="pepecoin-${PEPECOIN_VERSION}-${PEP_ARCH}.tar.gz"; \
    URL="https://github.com/pepecoinppc/pepecoin/releases/download/v${PEPECOIN_VERSION}/${TARBALL}"; \
    echo "Downloading ${URL}"; \
    curl -fsSL --retry 5 --retry-delay 3 -o "/tmp/${TARBALL}" "${URL}"; \
    echo "${PEP_SHA}  /tmp/${TARBALL}" | sha256sum -c -; \
    mkdir -p /opt/pepecoin; \
    tar -xzf "/tmp/${TARBALL}" -C /opt/pepecoin --strip-components=1; \
    rm -f "/tmp/${TARBALL}"; \
    # keep only what we actually need
    rm -rf /opt/pepecoin/bin/pepecoin-qt /opt/pepecoin/bin/test_pepecoin /opt/pepecoin/lib /opt/pepecoin/include; \
    chmod +x /opt/pepecoin/bin/*; \
    /opt/pepecoin/bin/pepecoind --version | head -1

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION}

ARG PEPECOIN_VERSION
LABEL org.opencontainers.image.title="Pepecoin Core" \
      org.opencontainers.image.description="Pepecoin Core full node (official binaries) packaged for Umbrel" \
      org.opencontainers.image.version="${PEPECOIN_VERSION}" \
      org.opencontainers.image.source="https://github.com/pepecoinppc/pepecoin" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates gosu openssl libstdc++6 libgcc-s1; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 1000 pepecoin; \
    useradd -u 1000 -g 1000 -m -s /bin/bash pepecoin

COPY --from=builder /opt/pepecoin/bin/ /usr/local/bin/
COPY entrypoint.sh healthcheck.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

ENV PEPECOIN_DATA=/data/.pepecoin
VOLUME ["/data"]

# P2P mainnet, RPC mainnet
EXPOSE 33874 33873

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pepecoind"]
