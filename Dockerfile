# The traintime poller: records the MTA feeds and serves live state, replay and history.
# Build:  docker build -t traintime-poller .
# Run:    docker run -p 7118:7118 -v traintime-data:/data -e TRAINTIME_DATA_DIR=/data traintime-poller
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# The poller needs devDependencies (tsx) to run TypeScript directly.
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json ./
COPY services ./services
COPY src ./src
COPY scripts ./scripts
COPY public/data/network.json ./public/data/network.json
# Learned timing ships with the image so a fresh poller predicts well from its first tick. It is
# not copied onto the volume: the poller compares timestamps and uses whichever is newer, so a
# deploy with better tables wins, and so does a night of learning.
COPY public/data/timing.json public/data/eta-model.json /app/public/data/

# Recordings and learned tables live on the mounted volume.
ENV TRAINTIME_DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 7118
# Seed the volume with the shipped tables on first boot only, then start.
CMD ["npx", "tsx", "services/poller/index.ts"]
