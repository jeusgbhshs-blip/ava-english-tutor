FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production AVA_DATA_DIR=/app/data
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node content ./content
COPY --chown=node:node web ./web
RUN mkdir -p /app/data /app/.runtime && chown -R node:node /app/data /app/.runtime
USER node
EXPOSE 5180
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:5180/api/access/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js", "--host", "0.0.0.0", "--port", "5180"]
