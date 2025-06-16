# 使用官方 Node.js LTS (Long Term Support) 版本作为基础镜像
FROM docker.m.daocloud.io/node:18-alpine

# 在容器内创建并设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 和 package-lock.json (或 yarn.lock)
COPY package*.json ./

# 安装项目依赖
RUN npm install
# 如果您使用 yarn，请取消注释下一行并注释掉上面的 npm install
# RUN yarn install

# 将项目代码复制到工作目录
COPY . .

# 应用程序的默认启动命令
CMD [ "node", "main.js" ]