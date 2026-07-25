FROM node:18-bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Instalação das dependências binárias (Chromium, FFmpeg, Python)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    python3 \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Instalação do yt-dlp atualizado diretamente do repositório oficial
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Otimização da camada de cache do Docker
COPY package*.json ./
RUN npm install --production

# Cópia do código da aplicação
COPY . .

# Exposição da porta para o Healthcheck do Render
EXPOSE 10000

CMD ["npm", "start"]
