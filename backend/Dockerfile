# The API. Build: docker build -t lastbite-api backend
# Config comes from the environment at run time (an --env-file), never baked into the image.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# Runs the TypeScript scripts in place: migrations, seeding, making a super admin.
RUN npm install -g tsx@4.23.15
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The scripts import from src, and migrate reads db/migrations.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Not npm start: that forces NODE_ENV=production, and staging runs in development with the fakes.
CMD ["node", "dist/server.js"]
