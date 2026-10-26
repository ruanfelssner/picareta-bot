FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Diagnóstico gráfico opcional; ativado explicitamente com FAVARETO_BROWSER_DEBUG=1.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Garante que o Chromium tenha a mesma revisão do pacote Playwright instalado.
RUN pnpm exec playwright install chromium

COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV FAVARETO_BROWSER_DEBUG=0
CMD ["pnpm", "start:combined"]
