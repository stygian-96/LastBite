# The website. NEXT_PUBLIC_* values are baked in when the image is built, so pass them as build args:
#   docker build -t lastbite-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 frontend
# Anything else (DEV_CAPTURE_SECRET) is read at run time.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_API_MOCK=0
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DEV_CAPTURE=0
ENV NEXT_PUBLIC_API_MOCK=$NEXT_PUBLIC_API_MOCK \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_DEV_CAPTURE=$NEXT_PUBLIC_DEV_CAPTURE \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Standalone output: a server.js with only the files it needs, no node_modules install.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
