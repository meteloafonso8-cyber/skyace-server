FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
ENV PORT=8080 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 8080
CMD ["node", "server.js"]
