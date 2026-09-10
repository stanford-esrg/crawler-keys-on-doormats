# Use Ubuntu 22.04 as base image
FROM ubuntu:22.04

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=18.19.0
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV DISPLAY=:99
ENV VNC_PORT=5900

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    software-properties-common \
    apt-transport-https \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libasound2 \
    tigervnc-standalone-server \
    default-jre \
    xvfb \
    x11vnc \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Create output directory
RUN mkdir -p /app/output

# Create local output directory for mounting
RUN mkdir -p /home/XXXX-4/crawler/output

# Create non-root user for security
RUN groupadd -r crawler && useradd -r -g crawler -G audio,video crawler \
    && mkdir -p /home/crawler/Downloads \
    && chown -R crawler:crawler /app \
    && chown -R crawler:crawler /home/crawler \
    && chown -R crawler:crawler /home/XXXX-4/crawler/output

# Create VNC startup script (works for both root and crawler user)
RUN echo '#!/bin/bash\n\
export DISPLAY=:99\n\
# Start Xvfb in background\n\
Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &\n\
sleep 3\n\
# Start window manager\n\
fluxbox &\n\
sleep 2\n\
# Start VNC server\n\
x11vnc -display :99 -nopw -listen localhost -xkb -ncache 10 -ncache_cr -forever -shared &\n\
sleep 2\n\
# Execute the main command\n\
exec "$@"' > /usr/local/bin/start-vnc.sh && \
    chmod +x /usr/local/bin/start-vnc.sh

# Keep as root for permission compatibility
# USER crawler

# Expose VNC port
EXPOSE 5900

# Default command with VNC
CMD ["/usr/local/bin/start-vnc.sh", "node", "crawler.js"]
