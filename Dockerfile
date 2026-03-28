FROM node:22-slim

# Install claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Set up app
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY dist/ ./dist/

# Log dir mount point
RUN mkdir -p /root/.polymarket-arb

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--paper"]
