# The Foundry studio, hosted (owner, 2026-10-05), at foundry.audiovibe.co.
#
# ffmpeg renders and mixes audio; the fonts are for drawn cover art (resvg
# reads system fonts, and Liberation Sans stands in for Arial).
#
# EVERYTHING THE STUDIO WRITES lives on the volume at /data, not in this image:
# scripts/start.sh links runs/, art/, music/ and the record files into place
# before the studio starts, so a redeploy never loses a run.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-liberation fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci

COPY . .
RUN npm --prefix web run build

ENV NODE_ENV=production \
    FOUNDRY_HOST=0.0.0.0 \
    FOUNDRY_DATA_DIR=/data

CMD ["bash", "scripts/start.sh"]
