# Reproducible environment for the opencode-notify e2e suite: the OpenCode V2
# CLI, Zellij to host the TUIs in real tabs, and tui-test to attach a real
# client to the Zellij session. The plugin under test is copied in from the
# working tree; the API key is supplied at runtime, not baked in.
#
#   docker build -f e2e/Dockerfile -t opencode-notify-e2e .
#   docker run --rm -e E2E_ENDPOINT -e E2E_MODEL -e E2E_API_KEY opencode-notify-e2e
#   docker run --rm -e E2E_ENDPOINT -e E2E_MODEL -e E2E_API_KEY opencode-notify-e2e 10   # subset

FROM debian:bookworm-slim

ARG OPENCODE_VERSION=2.2.5

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

# OpenCode V2, the same release channel Homebrew installs.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        arm64) oarch=arm64 ;; \
        *) oarch=x64-baseline ;; \
    esac; \
    curl -fsSL "https://opencode.ai/files/bin/${OPENCODE_VERSION}/opencode-linux-${oarch}.tar.gz" \
        | tar -xz -C /usr/local/bin opencode; \
    opencode --version

# Zellij hosts each TUI in its own tab; the plugin blinks tabs through it.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        arm64) zarch=aarch64 ;; \
        *) zarch=x86_64 ;; \
    esac; \
    curl -fsSL "https://github.com/zellij-org/zellij/releases/latest/download/zellij-${zarch}-unknown-linux-musl.tar.gz" \
        | tar -xz -C /usr/local/bin zellij; \
    zellij --version

# tui-test CLI.
RUN curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/microsoft/tui-test/main/install/install.sh | sh
ENV PATH="/root/.local/bin:/root/.cargo/bin:${PATH}"

COPY package.json index.js /plugin/
COPY lib /plugin/lib
COPY e2e /e2e

ENV E2E_PLUGIN_DIR=/plugin
# Enables the container-only Zellij scenarios.
ENV E2E_ALLOW_ZELLIJ=1
WORKDIR /e2e
ENTRYPOINT ["/e2e/run.sh"]
