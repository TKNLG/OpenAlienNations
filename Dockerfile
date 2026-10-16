# OpenAlienNations server image. Contains only our code and the HD UI pack; mount your own game folder at /game.
#
#   docker build -t openaliennations .
#   docker run -d -p 8080:8080 -v "/mnt/user/games/Alien Nations:/game:ro" openaliennations
#
# Unraid: add a container with this image, port 8080 -> 8080, and a read-only path mapping
# from your Alien Nations folder (the one containing Data/ and Bin/) to /game.
# Soundtrack from another folder: add -v "/path/to/music:/music:ro" -e AN_MUSIC=/music.
# Release images: ghcr.io/<owner>/openaliennations:<version> (built by .github/workflows/release.yml).
# License: GPL-3.0-or-later (/app/LICENSE); the HD UI pack is not covered by it (/app/NOTICE).

# build stage: zero-dependency TypeScript strip (build.mjs); runs on the build machine's platform
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
COPY package.json build.mjs ./
COPY src/ ./src/
RUN node build.mjs

# runtime stage: no RUN steps, so multi-arch images need no emulation
FROM node:24-alpine
LABEL org.opencontainers.image.title="OpenAlienNations" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
WORKDIR /app
COPY LICENSE NOTICE ./
COPY --from=build /src/dist/ ./dist/
COPY hd/ ./hd/
ENV AN_GAME=/game AN_PORT=8080 AN_HOST=0.0.0.0
VOLUME ["/game"]
EXPOSE 8080
USER node
CMD ["node", "dist/server.mjs"]
