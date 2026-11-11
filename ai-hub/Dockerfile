# 企业 AI 中台自身镜像（infra/docker-compose.yml 的 full profile 使用）
# 宿主机直接跑（npm run hub）不需要此镜像；全容器化部署时由 compose 构建。
FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# 先拷依赖清单利用层缓存（仓库无锁文件，用 install；生产建议提交 package-lock.json 后改 npm ci）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY fixtures/ ./fixtures/

# 中台要代管应用的 docker build/run：镜像内装 docker CLI，配合挂载的 docker.sock 使用
# （等价于宿主 root 权限，安全边界说明见 outputs/生产部署指南.md）
RUN apk add --no-cache docker-cli

# 生产域名/端口由 infra/.env 注入，这里只留本地默认值
ENV HUB_PORT=8080
ENV HUB_DOMAIN=localhost

USER node
EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "scripts/dev-server.mjs"]
