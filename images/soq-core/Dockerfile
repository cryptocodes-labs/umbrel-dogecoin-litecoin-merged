#
# Soqucoin Core — built from the OFFICIAL release binaries published by the
# Soqucoin developers, verified against the SHA256 sums in the release's
# SHA256SUMS. Soqucoin publishes no PGP signature (October 2026); the sums come
# from the same GitHub release, so the pin below is what guards against a
# changed file after the fact.
#
# The release tarball holds two binaries at its root, soqucoind and
# soqucoin-cli, linked statically against everything but glibc (they need
# GLIBC 2.34 at most; Debian 12 ships 2.36).
#
# Nothing is pulled from third-party images.

ARG DEBIAN_VERSION=bookworm-slim
ARG SOQUCOIN_VERSION=2.6.1

# ---------------------------------------------------------------------------
# Stage 1: download + verify + extract
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION} AS builder

# pipefail matters here: the checksum is verified through a pipe.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG SOQUCOIN_VERSION
ARG TARGETARCH

# SHA256 sums taken verbatim from
# https://github.com/soqucoin/soqucoin/releases/download/v2.6.1/SHA256SUMS
ARG SHA256_AMD64=1028fb29431fa02a4279e8758dba0278771a4832a9cfbc87d8a0f2d14bcf103c
ARG SHA256_ARM64=97b50e5f4e860f15ef9bb1847f434d494e37fd91ddfd4ee8d30206722f502acf

# Debian package versions are deliberately unpinned: the archive rotates them
# out, and a pinned version turns into an unbuildable image within months. What
# actually matters for reproducibility — the Soqucoin binaries — is pinned by
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
      amd64) SOQ_ARCH="linux-x64";   SOQ_SHA="${SHA256_AMD64}" ;; \
      arm64) SOQ_ARCH="linux-arm64"; SOQ_SHA="${SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
    esac; \
    TARBALL="soqucoin-v${SOQUCOIN_VERSION}-${SOQ_ARCH}.tar.gz"; \
    URL="https://github.com/soqucoin/soqucoin/releases/download/v${SOQUCOIN_VERSION}/${TARBALL}"; \
    echo "Downloading ${URL}"; \
    curl -fsSL --retry 5 --retry-delay 3 -o "/tmp/${TARBALL}" "${URL}"; \
    echo "${SOQ_SHA}  /tmp/${TARBALL}" | sha256sum -c -; \
    # The tarball must hold exactly the two programs and nothing else; a
    # release that suddenly ships more is refused rather than copied in.
    CONTENTS="$(tar -tzf "/tmp/${TARBALL}" | sed 's#^\./##' | grep -v '^$' | sort | tr '\n' ' ')"; \
    [ "${CONTENTS}" = "soqucoin-cli soqucoind " ] || { echo "unexpected tarball contents: ${CONTENTS}" >&2; exit 1; }; \
    mkdir -p /opt/soqucoin/bin; \
    tar -xzf "/tmp/${TARBALL}" -C /opt/soqucoin/bin ./soqucoind ./soqucoin-cli; \
    rm -f "/tmp/${TARBALL}"; \
    chmod +x /opt/soqucoin/bin/soqucoind /opt/soqucoin/bin/soqucoin-cli; \
    /opt/soqucoin/bin/soqucoind --version | head -1

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_VERSION}

ARG SOQUCOIN_VERSION
LABEL org.opencontainers.image.title="Soqucoin Core" \
      org.opencontainers.image.description="Soqucoin Core node (official binaries) packaged for Umbrel" \
      org.opencontainers.image.version="${SOQUCOIN_VERSION}" \
      org.opencontainers.image.source="https://github.com/soqucoin/soqucoin" \
      org.opencontainers.image.licenses="MIT"

# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates gosu openssl; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd -g 1000 soqucoin; \
    useradd -u 1000 -g 1000 -m -s /bin/bash soqucoin

COPY --from=builder /opt/soqucoin/bin/ /usr/local/bin/
COPY entrypoint.sh healthcheck.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

ENV SOQUCOIN_DATA=/data/.soqucoin
VOLUME ["/data"]

# P2P mainnet, RPC mainnet
EXPOSE 33388 33389

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["soqucoind"]
