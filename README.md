# MixLite - 混合AI代理系统

## 项目简介

MixLite是一个创新的混合AI代理系统，它采用了双模型工作流架构，通过思考模型(Thinking Model)和输出模型(Output Model)的协同工作，提供更深入、更全面的AI响应。系统首先使用思考模型对用户输入进行深度分析和逻辑推理，然后由输出模型基于这些思考结果生成最终的回答。

## `oneapi-version` 分支特性

此 `oneapi-version` 分支在原项目基础上进行了以下主要改进和调整，旨在提升与类似 OneAPI/newapi 等管理工具的兼容性，并增强开发者体验：

1.  **默认非流式响应以优化兼容性:**
    *   为了更好地兼容默认期望非流式（完整 JSON）响应的客户端（如 OneAPI/newapi），当客户端请求中未明确指定 `stream` 参数时，此分支的 MixLite 将默认采用**非流式响应**。
    *   需要流式响应的客户端仍然可以通过在请求体中明确设置 `"stream": true` 来获取流式数据。

2.  **增强的详细日志系统:**
    *   引入了新的环境变量 `LOG_FULL_CONTENT`。您可以在 `.env` 文件中设置此变量 (参考 `.env.example`)。
    *   当 `LOG_FULL_CONTENT=true` 时，后端日志将记录非常详细的信息，包括完整的思考链 (`thinkingContent`)、完整的用户输入消息、以及输出模型返回的完整内容（对于非流式和累积的流式响应）。
    *   如果未设置或设为 `false`，日志将保持简洁，主要输出摘要信息。这对于生产环境更友好，同时在需要时可以开启详细日志进行调试。

3.  **流式请求任务处理修复:**
    *   修正了在处理完一个流式请求后，内部任务状态可能未被正确重置的问题。这提高了在连续（尤其是快速连续）发送流式请求时的稳定性和可靠性。

4.  **Docker 化支持:**
    *   项目中已添加 `Dockerfile` 和 `docker-compose.yml` 文件，方便开发者使用 Docker 进行本地构建、部署和开发测试。
    *   `docker-compose.yml` 配置支持通过挂载本地项目目录（包括 `.env` 文件）进行开发，并通过 `dotenv` 在应用内加载环境变量。

5.  **`.env.example` 更新:**
    *   示例配置文件 `.env.example` 已更新，加入了 `LOG_FULL_CONTENT` 变量的说明和示例。
    *   API 密钥等敏感配置项使用了标准的占位符。
## 系统架构

### 双模型工作流

1. **思考模型 (Thinking Model)**
   - 负责对用户输入进行深度分析
   - 生成逻辑思维链
   - 进行思维广泛化和自纠错
   - 当使用04-17模型时自动调用最大思维算力

2. **输出模型 (Output Model)**
   - 基于思考模型的分析结果
   - 生成最终的用户响应
   - 保持连贯的对话风格
   - 默认模型：grok-3

### 数据流程

```
用户输入 -> 思考模型分析 -> 生成思维链 -> 输出模型处理 -> 最终响应
```

## 部署说明

### 环境要求

- Node.js环境
- 必要的NPM包（见package.json）

### 安装步骤

1. 克隆项目到本地
2. 安装依赖：
   ```bash
   npm install
   ```
3. 配置环境变量：
   - 复制`.env.example`为`.env`
   - 填写必要的配置信息：
     - 代理服务器端口
     - API密钥
     - 模型参数等

## 配置说明

### 关键配置项

1. **基础配置**
   - `PROXY_PORT`: 代理服务器端口（默认4120）
   - `HYBRID_MODEL_NAME`: 混合模型名称
   - `OUTPUT_API_KEY`: 输出API密钥

   - `LOG_FULL_CONTENT`: (可选, 默认为 `false`) 设置为 `true` 时，启用非常详细的后端日志记录，包括完整的思考链、用户消息详情和模型响应内容。有助于深度调试。

2. **思考模型配置**
   - `PROXY_URL`: 思考模型API地址
   - `Model_think_API_KEY`: API密钥
   - `Model_think_TEMPERATURE`: 温度参数
   - `Model_think_WebSearch`: 是否启用网络搜索

3. **输出模型配置**
   - `PROXY_URL2`: 输出模型API地址
   - `Model_output_API_KEY`: API密钥
   - `Model_output_TEMPERATURE`: 温度参数
   - `Model_output_tool`:输出模型是否回应FunctionTool字段

## 使用方法

### 启动服务

1. 直接运行启动脚本：
   ```bash
   ./启动MixLite.bat
   ```
   或
   ```bash
   npm start
   ```

### 使用 Docker 启动 (推荐)

此分支已包含 `Dockerfile` 和 `docker-compose.yml` 文件，推荐使用 Docker 进行部署和开发。

1.  确保您已安装 Docker 和 Docker Compose。
2.  在项目根目录下（即 `Mixlite` 目录），根据 `.env.example` 文件创建并配置好您的 `.env` 文件。
3.  执行以下命令来构建镜像并启动服务：
    ```bash
    docker compose up --build -d
    ```
    此命令会在后台构建并启动服务。如果您想查看实时日志，可以去掉 `-d` 参数：
    ```bash
    docker compose up --build
    ```
4.  服务将根据 `docker-compose.yml` 中定义的端口映射（默认为外部主机端口 `3032` 映射到容器内部的 `4120` 端口）启动。您可以通过 `http://localhost:3032/v1/chat/completions` 来访问服务。

### API调用

- 端点：`/v1/chat/completions`
- 方法：POST
- 请求头：
  ```
  Authorization: Bearer YOUR_API_KEY
  Content-Type: application/json
  ```
- 请求体示例：
  ```json
  {
    "model": "MixLite",
    "messages": [
      {"role": "user", "content": "你好，请介绍一下你自己"}
    ],
    "stream": true
  }
  ```

## 性能优化建议

1. **思考模型参数调优**
   - 适当调整temperature参数（0.7-0.9）
   - 根据需求启用/禁用WebSearch
   - 调整TopK和TopP参数优化输出质量

2. **输出模型参数调优**
   - 根据应用场景调整temperature
   - 适当设置max_tokens限制

## 注意事项

1. API密钥安全
   - 妥善保管API密钥
   - 避免密钥泄露
   - 定期更换密钥

2. 错误处理
   - 系统会自动处理并取消重复请求
   - 支持流式输出的错误处理
   - 请求超时设置为30秒

3. 资源限制
   - 注意模型的token限制
   - 合理设置并发请求数
   - 监控服务器资源使用

## 系统特点

- 双模型协同：通过思考模型和输出模型的配合，提供更深入的分析和更准确的回答
- 流式响应：支持流式输出，提供实时的响应体验
- 灵活配置：丰富的配置选项，可根据需求调整系统行为
- 错误处理：完善的错误处理机制，确保系统稳定运行
- 工具交互：支持与MCP工具的交互，实现更复杂的任务处理

## 技术栈

- Express.js：Web服务器框架
- Axios：HTTP客户端
- Dotenv：环境变量管理
- 其他依赖：见package.json
