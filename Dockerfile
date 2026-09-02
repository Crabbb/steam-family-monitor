FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npx prisma generate
RUN npm run build

# Create data directory for SQLite database (will be volume-mounted)
RUN mkdir -p /app/prisma/data

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/prisma/data/dev.db

CMD ["sh", "-c", "touch /app/prisma/data/dev.db && npx prisma db push && npm start"]
