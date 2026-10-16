#
# Litecoin Core — built from the OFFICIAL release binaries published by the
# Litecoin Core developers, verified against the SHA256 sums that are GPG-signed
# in SHA256SUMS.asc of the release.
#
# Nothing is pulled from third-party images.

ARG DEBIAN_VERSION=bookworm-slim
ARG LITECOIN_VERSION=0.21.5.8

# ---------------------------------------------------------------------------
# Stage 1: download + verify + extract
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION} AS builder

# pipefail matters here: the checksum is verified through a pipe.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG LITECOIN_VERSION
ARG TARGETARCH

# SHA256 sums taken verbatim from
# https://github.com/litecoin-project/litecoin/releases/download/v0.21.5.8/SHA256SUMS.asc
# (PGP-signed by the Litecoin Core maintainers), and identical in the copy at
# https://download.litecoin.org/litecoin-0.21.5.8/SHA256SUMS.asc
ARG SHA256_AMD64=43200c9f9d65ebc126ea5833ca9429e144c4b3273da6bb9f4e89fd7450ab1be9
ARG SHA256_ARM64=129f55defb9045d5635566382c7b9f6fd227d4106a6fc07847a38b25ff9b29a1

# Debian package versions are deliberately unpinned: the archive rotates them
# out, and a pinned version turns into an unbuildable image within months. What
# actually matters for reproducibility — the Litecoin binaries — is pinned by
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
      amd64) LTC_ARCH="x86_64-linux-gnu";  LTC_SHA="${SHA256_AMD64}" ;; \
      arm64) LTC_ARCH="aarch64-linux-gnu"; LTC_SHA="${SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac; \
    TARBALL="litecoin-${LITECOIN_VERSION}-${LTC_ARCH}.tar.gz"; \
    URL="https://github.com/litecoin-project/litecoin/releases/download/v${LITECOIN_VERSION}/${TARBALL}"; \
    echo "Downloading ${URL}"; \
    curl -fsSL --retry 5 --retry-delay 3 -o "/tmp/${TARBALL}" "${URL}"; \
    echo "${LTC_SHA}  /tmp/${TARBALL}" | sha256sum -c -; \
    mkdir -p /opt/litecoin; \
    tar -xzf "/tmp/${TARBALL}" -C /opt/litecoin --strip-components=1; \
    rm -f "/tmp/${TARBALL}"; \
    # keep only what we actually need
    rm -rf /opt/litecoin/bin/litecoin-qt /opt/litecoin/bin/test_litecoin \
           /opt/litecoin/lib /opt/litecoin/include /opt/litecoin/share; \
    chmod +x /opt/litecoin/bin/*; \
    /opt/litecoin/bin/litecoind --version | head -1

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION}

ARG LITECOIN_VERSION
LABEL org.opencontainers.image.title="Litecoin Core" \
      org.opencontainers.image.description="Litecoin Core full node (official binaries) packaged for Umbrel" \
      org.opencontainers.image.version="${LITECOIN_VERSION}" \
      org.opencontainers.image.source="https://github.com/litecoin-project/litecoin" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates gosu openssl libstdc++6 libgcc-s1; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 1000 litecoin; \
    useradd -u 1000 -g 1000 -m -s /bin/bash litecoin

COPY --from=builder /opt/litecoin/bin/ /usr/local/bin/
COPY entrypoint.sh healthcheck.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

ENV LITECOIN_DATA=/data/.litecoin
VOLUME ["/data"]

# P2P mainnet, RPC mainnet
EXPOSE 9333 9332

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["litecoind"]
