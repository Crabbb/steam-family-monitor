# ---- build stage: needs devDependencies (next build, typescript, tailwind) ----
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY . .

RUN npx prisma generate
RUN npm run build

# ---- runtime stage: production dependencies only ----
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL=file:/app/prisma/data/dev.db

# tsx and the prisma CLI are runtime dependencies here: the server is started
# as `tsx server.ts` and the schema is synced with `prisma db push` on boot.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
COPY --from=builder /app/.next ./.next

# Regenerate against this stage's pruned node_modules.
RUN npx prisma generate

# Data directory for the SQLite database (volume-mounted in compose).
RUN mkdir -p /app/prisma/data

EXPOSE 3000

CMD ["sh", "-c", "touch /app/prisma/data/dev.db && npx prisma db push && npm start"]
