FROM mcr.microsoft.com/playwright:v1.54.0-noble

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
CMD ["pnpm", "start:cloud"]
