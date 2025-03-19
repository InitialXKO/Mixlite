# MixLite - 混合AI代理系统

## 项目简介

MixLite是一个创新的混合AI代理系统，它采用了双模型工作流架构，通过思考模型(Thinking Model)和输出模型(Output Model)的协同工作，提供更深入、更全面的AI响应。系统首先使用思考模型对用户输入进行深度分析和逻辑推理，然后由输出模型基于这些思考结果生成最终的回答。

## 系统架构

### 双模型工作流

1. **思考模型 (Thinking Model)**
   - 负责对用户输入进行深度分析
   - 生成逻辑思维链
   - 进行思维广泛化和自纠错
   - 默认模型：gemini-2.0-flash-thinking-exp

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
