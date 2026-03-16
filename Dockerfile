FROM python:3.11-slim AS base

# Install Node.js 22.x
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy app code into image
COPY . .

# Install Python deps for the RAG pipeline
RUN pip install --no-cache-dir -r intelligence/requirements.txt

# Install Node deps for phixo-admin
RUN npm install --omit=dev

ENV NODE_ENV=production

CMD ["node", "server.js"]

