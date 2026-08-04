FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Garante que o Chromium tenha a mesma revisão do pacote Playwright instalado.
RUN pnpm exec playwright install chromium

COPY . .
RUN pnpm build

ENV NODE_ENV=production
CMD ["pnpm", "start:combined"]
