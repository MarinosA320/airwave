# Runs the Airwave server in any container host (Fly.io, Railway, a VPS...). Render uses render.yaml instead.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY atc-client ./atc-client
COPY data ./data
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/server.js"]
