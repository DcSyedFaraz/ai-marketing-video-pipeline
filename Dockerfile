FROM node:20-slim

# Install full system ffmpeg (includes all filters: aevalsrc, xfade, lavfi, etc.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create output/upload dirs so the app can write files
RUN mkdir -p public/output public/uploads

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
